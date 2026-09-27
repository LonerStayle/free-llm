package dev.freellmrouter

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.random.Random
import kotlin.time.TimeSource

/**
 * 무료 LLM 폴백 라우터 (SPEC 1·2절).
 *
 * 상태(실패 기록·쿨다운)는 메모리에만, 인스턴스 단위로 둔다. 여러 코루틴에서 동시에 불러도 된다.
 * 기본 transport 를 쓰면 다 쓴 뒤 [close] 로 HTTP 클라이언트를 닫는다.
 */
@OptIn(ExperimentalAtomicApi::class)
class Router(
    val config: Config,
    keys: Map<String, String>,
    options: RouterOptions = RouterOptions(),
) : AutoCloseable {
    private val keys: Map<String, String> = keys.toMap()
    private val ownsTransport = options.transport == null
    private val transport: Transport by lazy { options.transport ?: KtorTransport() }
    private val rng: () -> Double = options.rng ?: { Random.nextDouble() }
    private val now: () -> Long = options.now ?: ::defaultNowMs
    private val settings = config.settings

    // 배포마다 불변 상태 하나를 원자적으로 바꾼다 (SPEC 1.3)
    private class DepState(val failures: List<Long>, val cooldownUntil: Long?)

    private val empty = DepState(emptyList(), null)
    private val states: Map<String, AtomicReference<DepState>> =
        config.groups.values.flatten().associate { it.id to AtomicReference(empty) }

    /**
     * [group] 으로 요청을 보낸다. [request] 는 chat/completions 본문에서 model 을 뺀 것.
     * 실패하면 [RouterError], 호출자 코루틴이 취소되면 CancellationException 을 던진다 (SPEC 1.1).
     * @Throws 가 있어야 Swift 에서 직접 불러도 앱이 죽지 않고 NSError 로 받는다.
     */
    @Throws(RouterError::class, CancellationException::class)
    suspend fun route(group: String, request: JsonObject): RouteResult {
        if (group !in config.groups) throw RouterError(ErrorKind.INVALID_REQUEST, "unknown group: $group")
        val messages = request["messages"] as? JsonArray
            ?: throw RouterError(ErrorKind.INVALID_REQUEST, "request.messages must be an array")
        if (isJsonTrue(request["stream"])) throw RouterError(ErrorKind.INVALID_REQUEST, "stream is not supported")

        val tokens = estimateTokens(messages)
        val attempted = HashSet<String>()
        val attempts = ArrayList<Attempt>()
        val visited = LinkedHashSet<String>()
        val queue = ArrayDeque(listOf(group))
        val reasons = ArrayList<EndReason>()
        while (queue.isNotEmpty()) {
            val g = queue.removeFirst()
            visited += g
            val r = runGroup(g, request, tokens, attempted, attempts)
            if (r is GroupRun.Success) return r.result
            val reason = (r as GroupRun.Ended).reason
            reasons += reason
            val next = if (reason == EndReason.CONTEXT) settings.contextWindowFallbacks[g] else settings.fallbacks[g]
            for (n in next.orEmpty()) if (n !in visited && n !in queue) queue.addLast(n)
        }
        val kind = if (reasons.all { it == EndReason.CONTEXT }) ErrorKind.CONTEXT_WINDOW_EXCEEDED else ErrorKind.ALL_FAILED
        throw RouterError(kind, "all deployments failed (groups: ${visited.joinToString(" -> ")})", attempts = attempts.toList())
    }

    /** 설정의 모든 배포(비활성·키 없음 포함) 상태. 진단·테스트용. */
    fun deploymentStates(): Map<String, DeploymentState> {
        val t = now()
        val window = settings.cooldownMs
        val out = LinkedHashMap<String, DeploymentState>()
        for (d in config.groups.values.flatten()) {
            val s = states.getValue(d.id).load()
            val cooling = s.cooldownUntil != null && t < s.cooldownUntil
            out[d.id] = DeploymentState(
                coolingDown = cooling,
                cooldownUntilMs = if (cooling) s.cooldownUntil else null,
                recentFailures = s.failures.count { t - it < window },
            )
        }
        return out
    }

    /** 모든 배포의 실패 기록·쿨다운을 비운다. 연결 복구 시 부른다 (SPEC 1.4). */
    fun resetState() {
        for (ref in states.values) ref.store(empty)
    }

    /** 기본 transport(HTTP 클라이언트)를 만들었으면 닫는다. 주입한 transport 는 건드리지 않는다. */
    override fun close() {
        if (ownsTransport) (transport as? AutoCloseable)?.close()
    }

    // ── 내부 ────────────────────────────────────────────

    private enum class EndReason { CONTEXT, RETRYABLE }

    private sealed interface GroupRun {
        class Success(val result: RouteResult) : GroupRun
        class Ended(val reason: EndReason) : GroupRun
    }

    private sealed interface Sent {
        class Response(val status: Int, val text: String) : Sent
        class Failed(val outcome: Outcome, val message: String) : Sent
    }

    private suspend fun runGroup(
        g: String,
        request: JsonObject,
        tokens: Long,
        attempted: MutableSet<String>,
        attempts: MutableList<Attempt>,
    ): GroupRun {
        val maxAttempts = 1L + settings.numRetries
        var n = 0L
        var last: EndReason? = null
        var tokenExcludedAtStart = false
        while (n < maxAttempts) {
            currentCoroutineContext().ensureActive() // 취소 확인: 후보 계산·rng 전
            val (cands, tokenExcluded) = candidates(g, tokens, attempted, now())
            if (cands.isEmpty()) {
                if (n == 0L) tokenExcludedAtStart = tokenExcluded
                break
            }
            val d = pickWeighted(cands, rng)
            attempted += d.id
            n++
            val mark = TimeSource.Monotonic.markNow()
            val sent = send(d, request)
            val durationMs = mark.elapsedNow().inWholeMilliseconds
            val attempt: Attempt
            var json: JsonObject? = null
            when (sent) {
                is Sent.Failed -> attempt = Attempt(d.id, g, sent.outcome, null, durationMs, sent.message)
                is Sent.Response -> {
                    val c = classifyResponse(sent.status, sent.text)
                    json = c.json
                    attempt = Attempt(d.id, g, c.outcome, sent.status, durationMs, null)
                }
            }
            attempts += attempt
            when (attempt.outcome) {
                Outcome.OK -> return GroupRun.Success(RouteResult(json!!, d.id, g, attempts.toList()))
                Outcome.FATAL_STATUS -> {
                    val r = sent as Sent.Response
                    throw RouterError(ErrorKind.NON_RETRYABLE, "${d.id} returned ${r.status}", r.status, r.text, attempts.toList())
                }
                Outcome.CONTEXT_EXCEEDED -> last = EndReason.CONTEXT // 실패 기록 안 함
                else -> { // retryable_status, bad_body, timeout, network_error
                    recordFailure(d.id, now())
                    last = EndReason.RETRYABLE
                }
            }
        }
        val reason = if (n > 0) last!! else if (tokenExcludedAtStart) EndReason.CONTEXT else EndReason.RETRYABLE
        return GroupRun.Ended(reason)
    }

    private fun key(provider: String): String? = keys[provider]?.takeIf { it.isNotEmpty() }

    private fun isCoolingDown(id: String, t: Long): Boolean {
        val until = states.getValue(id).load().cooldownUntil
        return until != null && t < until
    }

    private fun recordFailure(id: String, t: Long) {
        val ref = states.getValue(id)
        val window = settings.cooldownMs
        while (true) {
            val cur = ref.load()
            // 쿨다운 중에 늦게 도착한 실패도 그대로 기록한다 (SPEC 1.3)
            val kept = cur.failures.filter { t - it < window } + t
            val next = if (kept.size >= settings.allowedFails) DepState(emptyList(), saturatingAdd(t, window)) else DepState(kept, cur.cooldownUntil)
            if (ref.compareAndSet(cur, next)) return
        }
    }

    private fun candidates(g: String, tokens: Long, attempted: Set<String>, t: Long): Pair<List<Deployment>, Boolean> {
        val out = ArrayList<Deployment>()
        var tokenExcluded = false
        for (d in config.groups.getValue(g)) {
            if (!d.enabled) continue
            if (key(d.provider) == null) continue
            if (isCoolingDown(d.id, t)) continue
            if (d.id in attempted) continue
            if (d.maxInputTokens != null && tokens > d.maxInputTokens) {
                tokenExcluded = true
                continue
            }
            out += d
        }
        return out to tokenExcluded
    }

    private suspend fun send(d: Deployment, request: JsonObject): Sent {
        val p = config.providers.getValue(d.provider)
        val url = p.baseUrl.trimEnd('/') + "/chat/completions"
        val headers = LinkedHashMap<String, String>()
        headers["Content-Type"] = "application/json"
        headers["Authorization"] = "Bearer ${key(d.provider)}"
        headers.putAll(p.extraHeaders)
        val body = JsonObject(request + ("model" to JsonPrimitive(d.model))).toString()
        // withTimeoutOrNull(0) 은 블록을 실행하지 않는다. 한 시도 = HTTP 요청 한 번이므로 최소 1ms (setTimeout(0) 도 1ms)
        val timeoutMs = settings.timeoutMs.coerceAtLeast(1L)

        // 라우터 타이머만 시간 초과를 판정한다 (SPEC 3.6). withTimeoutOrNull 은 자기 타임아웃만 null 로 바꾸고
        // 호출자 취소는 그대로 던진다.
        val result = withTimeoutOrNull(timeoutMs) {
            try {
                val res = transport.send(url, headers, body)
                Sent.Response(res.status, res.text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // OkHttp·Ktor 는 취소를 IOException("Canceled") 로 바꿔 던지기도 한다.
                // 타임아웃·호출자 취소 때문이면 여기서 CancellationException 이 난다.
                currentCoroutineContext().ensureActive()
                Sent.Failed(Outcome.NETWORK_ERROR, e.message ?: e.toString())
            }
        }
        currentCoroutineContext().ensureActive() // transport 직후 취소 확인 (결과 분류 전)
        return result ?: Sent.Failed(Outcome.TIMEOUT, "timeout after ${timeoutMs}ms")
    }
}

// ── 순수 함수 (SPEC 2·3·4절) ──────────────────────────────

// 아주 큰 cooldownSeconds 에서 Long 이 넘쳐 쿨다운이 풀리지 않게
internal fun saturatingAdd(a: Long, b: Long): Long = if (b > 0 && a > Long.MAX_VALUE - b) Long.MAX_VALUE else a + b

private fun isJsonTrue(e: JsonElement?): Boolean = e is JsonPrimitive && !e.isString && e.content == "true"

/** tokens = ceil(units / 4), units = messages[*].content 의 UTF-16 코드 유닛 수 (SPEC 3.1) */
internal fun estimateTokens(messages: JsonArray): Long {
    var units = 0L
    for (m in messages) {
        when (val c = (m as? JsonObject)?.get("content")) {
            is JsonPrimitive -> if (c.isString) units += c.content.length
            is JsonArray -> for (part in c) {
                val text = (part as? JsonObject)?.get("text")
                if (text is JsonPrimitive && text.isString) units += text.content.length
            }
            else -> {}
        }
    }
    return (units + 3) / 4
}

internal fun pickWeighted(cands: List<Deployment>, rng: () -> Double): Deployment {
    val total = cands.sumOf { it.rpm.toLong() }.toDouble()
    val r = rng() * total
    var acc = 0.0
    for (d in cands) {
        acc += d.rpm
        if (acc > r) return d
    }
    return cands.last()
}

private val CONTEXT_PATTERNS = listOf("context length", "context_length", "maximum context", "too many tokens")

/** ASCII A–Z 만 a–z 로. 로캘·유니코드 소문자화를 쓰지 않는다 (SPEC 4절). */
internal fun asciiLower(text: String): String {
    val chars = text.toCharArray()
    for (i in chars.indices) if (chars[i] in 'A'..'Z') chars[i] = chars[i] + 32
    return chars.concatToString()
}

internal fun isRetryableStatus(status: Int): Boolean =
    status == 404 || status == 408 || status == 429 || status in 500..599

internal fun isContextError(status: Int, text: String): Boolean {
    if (status != 400 && status != 413) return false
    val lower = asciiLower(text)
    return CONTEXT_PATTERNS.any { it in lower }
}

internal class Classified(val outcome: Outcome, val json: JsonObject?)

internal fun classifyResponse(status: Int, text: String): Classified {
    if (status in 200..299) {
        val json = try {
            parseStrictJson(text)
        } catch (e: Exception) {
            return Classified(Outcome.BAD_BODY, null)
        }
        if (json !is JsonObject) return Classified(Outcome.BAD_BODY, null)
        val err = json["error"]
        if (err != null && err !is JsonNull) return Classified(Outcome.BAD_BODY, json)
        val choices = json["choices"]
        if (choices !is JsonArray || choices.isEmpty()) return Classified(Outcome.BAD_BODY, json)
        return Classified(Outcome.OK, json)
    }
    if (isContextError(status, text)) return Classified(Outcome.CONTEXT_EXCEEDED, null)
    if (isRetryableStatus(status)) return Classified(Outcome.RETRYABLE_STATUS, null)
    return Classified(Outcome.FATAL_STATUS, null)
}
