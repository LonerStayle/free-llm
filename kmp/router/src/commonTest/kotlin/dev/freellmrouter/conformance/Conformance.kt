package dev.freellmrouter.conformance

import dev.freellmrouter.ConfigError
import dev.freellmrouter.Router
import dev.freellmrouter.RouterError
import dev.freellmrouter.RouterOptions
import dev.freellmrouter.RouteResult
import dev.freellmrouter.Transport
import dev.freellmrouter.parseConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.time.TimeSource

/** 플랫폼 테스트가 넘겨 주는 것: 파일 읽기와 환경변수. */
class TestHost(
    val readText: (path: String) -> String,
    val env: (name: String) -> String?,
)

/** 제공처가 받은 요청 한 건 (SPEC 8.1 요청 로그) */
class Received(val path: String, val headers: Map<String, String>, val body: JsonElement)

/** 한 모드의 transport 와 요청 로그. */
interface Harness {
    val base: String
    /** null 이면 라우터 기본 transport (http 모드) */
    val transport: Transport?
    suspend fun load(responses: JsonObject)
    suspend fun log(): List<Received>
}

class CaseResult(val name: String, val skip: String?, val failures: List<String>, val ms: Long)

class ModeReport(val mode: String, val results: List<CaseResult>) {
    val ran get() = results.filter { it.skip == null }
    val passed get() = ran.count { it.failures.isEmpty() }
    val failed get() = ran.filter { it.failures.isNotEmpty() }
}

/**
 * spec/test-cases.json 적합성 러너 (SPEC 8.1·8.2). 참조 러너(run-conformance.mjs)의 규약을 그대로 따른다.
 */
class Conformance(private val host: TestHost) {
    val specDir: String = host.env("FLR_SPEC_DIR")?.takeIf { it.isNotEmpty() } ?: "../spec"
    private val suite = Json.parseToJsonElement(host.readText("$specDir/test-cases.json")).jsonObject
    private val clockStart = suite.getValue("clockStartMs").jsonPrimitive.long
    private val placeholder = suite.getValue("mockBasePlaceholder").jsonPrimitive.content
    private val only: String? = host.env("FLR_CASE")?.takeIf { it.isNotEmpty() }
    private val slow: Boolean = !host.env("FLR_SLOW").isNullOrEmpty()

    val cases: List<JsonObject> = suite.getValue("cases").jsonArray.map { it.jsonObject }.filter { only == null || it.str("name") == only }
    val configCases: List<JsonObject> =
        suite["configCases"]?.jsonArray.orEmpty().map { it.jsonObject }.filter { only == null || it.str("name") == only }

    private fun isSlow(c: JsonObject) = (c["tags"] as? JsonArray)?.any { (it as? JsonPrimitive)?.content == "slow" } == true

    private fun skipReason(c: JsonObject, mode: String): String? {
        if (!isSlow(c)) return null
        if (mode == "memory") return "slow: http only"
        return if (slow || only != null) null else "slow: FLR_SLOW=1"
    }

    /** models.json 이 parseConfig 를 통과하는지 */
    fun checkModelsJson(): List<String> = try {
        parseConfig(host.readText("$specDir/models.json"))
        emptyList()
    } catch (e: ConfigError) {
        listOf("models.json: ${e.message}")
    }

    fun runConfigCases(): List<String> {
        val failures = ArrayList<String>()
        val w = configCases.maxOfOrNull { it.str("name").length } ?: 0
        println("\n${"config case".padEnd(w)} | expect       | result")
        for (c in configCases) {
            val name = c.str("name")
            val expect = c.str("expect")
            var detail = ""
            val got = try {
                parseConfig(c.str("json"))
                "ok"
            } catch (e: ConfigError) {
                detail = " (${e.message})"
                "config_error"
            } catch (e: Exception) {
                "unexpected exception: $e"
            }
            val ok = got == expect
            if (!ok) failures += "$name: expected $expect, got $got$detail"
            println("${name.padEnd(w)} | ${expect.padEnd(12)} | ${if (ok) "PASS" else "FAIL got $got$detail"}")
        }
        println("config ${configCases.size - failures.size}/${configCases.size} passed")
        return failures
    }

    suspend fun runMode(mode: String, harnessFor: (JsonObject) -> Harness): ModeReport {
        val results = ArrayList<CaseResult>()
        for (c in cases) {
            val name = c.str("name")
            val skip = skipReason(c, mode)
            if (skip != null) {
                results += CaseResult(name, skip, emptyList(), 0)
                continue
            }
            val t0 = TimeSource.Monotonic.markNow()
            val failures = try {
                runCase(c, harnessFor(c))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                listOf("harness error: $e")
            }
            results += CaseResult(name, null, failures, t0.elapsedNow().inWholeMilliseconds)
        }
        val report = ModeReport(mode, results)
        printReport(report)
        return report
    }

    private fun printReport(r: ModeReport) {
        val w = maxOf(4, r.results.maxOfOrNull { it.name.length } ?: 0)
        println("\n[${r.mode}]")
        println("${"case".padEnd(w)} | result")
        println("${"-".repeat(w)}-|-${"-".repeat(20)}")
        for (c in r.results) {
            val cell = when {
                c.skip != null -> "SKIP ${c.skip}"
                c.failures.isEmpty() -> "PASS ${c.ms.toString().padStart(5)}ms"
                else -> "FAIL ${c.ms.toString().padStart(5)}ms"
            }
            println("${c.name.padEnd(w)} | $cell")
        }
        for (c in r.failed) {
            println("\nx ${c.name} [${r.mode}]")
            c.failures.forEach { println("    - $it") }
        }
        val skipped = r.results.size - r.ran.size
        println("\n[${r.mode}] ${r.passed}/${r.ran.size} passed (${r.results.size} cases; $skipped skipped)")
    }

    // ── 케이스 실행 ───────────────────────────────────────

    private suspend fun runCase(c: JsonObject, harness: Harness): List<String> {
        val failures = ArrayList<String>()
        val fail: (String) -> Unit = { failures += it }
        val config = substitute(c.getValue("config"), harness.base).jsonObject
        var clock = clockStart
        val rngValues = c.getValue("rng").jsonArray.map { it.jsonPrimitive.content.toDouble() }
        var rngIndex = 0
        val rng: () -> Double = {
            if (rngIndex >= rngValues.size) throw IllegalStateException("rng exhausted after ${rngValues.size} values")
            rngValues[rngIndex++]
        }
        harness.load(c["responses"] as? JsonObject ?: JsonObject(emptyMap()))
        val keys = c.getValue("keys").jsonObject.mapValues { it.value.jsonPrimitive.content }
        val router = Router(parseConfig(config.toString()), keys, RouterOptions(transport = harness.transport, rng = rng, now = { clock }))
        var seen = 0
        try {
            for ((i, step) in c.getValue("steps").jsonArray.map { it.jsonObject }.withIndex()) {
                val op = step.str("op")
                val where = "step $i ($op)"
                when (op) {
                    "advance" -> clock += step.getValue("ms").jsonPrimitive.long
                    "reset" -> router.resetState()
                    "expectState" -> {
                        val states = router.deploymentStates()
                        for ((id, want) in step.getValue("states").jsonObject) {
                            val got = states[id]
                            if (got == null) {
                                fail("$where unknown deployment $id")
                                continue
                            }
                            for ((k, v) in want.jsonObject) {
                                val actual: JsonElement = when (k) {
                                    "coolingDown" -> JsonPrimitive(got.coolingDown)
                                    "cooldownUntilMs" -> got.cooldownUntilMs?.let { JsonPrimitive(it) } ?: JsonNull
                                    "recentFailures" -> JsonPrimitive(got.recentFailures)
                                    else -> JsonPrimitive("<unknown field $k>")
                                }
                                if (!jsonEquals(actual, v)) fail("$where $id.$k expected $v, actual $actual")
                            }
                        }
                    }
                    "request" -> {
                        if (step["cancelAfterMs"] != null) {
                            seen = runCancelStep(fail, where, router, step, harness, seen)
                            continue
                        }
                        val ok = runRequestStep(fail, where, router, step, harness, config, seen)
                        if (ok == null) return failures // 예상 못 한 예외: 참조 러너처럼 케이스 중단
                        seen = ok
                    }
                    else -> fail("$where unknown op")
                }
            }
        } finally {
            router.close()
        }
        if (rngIndex != rngValues.size) fail("rng used $rngIndex of ${rngValues.size} values")
        return failures
    }

    /** 반환: 새 로그 위치. 예상 못 한 예외면 null. */
    private suspend fun runRequestStep(
        fail: (String) -> Unit,
        where: String,
        router: Router,
        step: JsonObject,
        harness: Harness,
        config: JsonObject,
        seen: Int,
    ): Int? {
        val e = step.getValue("expect").jsonObject
        var result: RouteResult? = null
        var error: RouterError? = null
        try {
            result = router.route(step.str("group"), step.getValue("request").jsonObject)
        } catch (x: RouterError) {
            error = x
        } catch (x: CancellationException) {
            throw x
        } catch (x: Exception) {
            fail("$where unexpected exception: $x")
            return null
        }
        val attempts = result?.attempts ?: error!!.attempts
        val expectOk = (e["ok"] as? JsonPrimitive)?.content == "true"
        if (expectOk) {
            if (result == null) {
                fail("$where expected success, got error ${error!!.kind} (${error.message})")
            } else {
                if (result.deploymentId != e.str("deployment")) fail("$where deployment ${result.deploymentId} != ${e.str("deployment")}")
                if (result.group != e.str("group")) fail("$where group ${result.group} != ${e.str("group")}")
                e["content"]?.let { want ->
                    val content = (((result.response["choices"] as? JsonArray)?.getOrNull(0) as? JsonObject)
                        ?.get("message") as? JsonObject)?.get("content") ?: JsonNull
                    if (!jsonEquals(content, want)) fail("$where content $content != $want")
                }
            }
        } else if (error == null) {
            fail("$where expected error, got success via ${result!!.deploymentId}")
        } else {
            val ee = e.getValue("error").jsonObject
            val kind = ee.str("kind")
            if (error.kind.value != kind) fail("$where error.kind ${error.kind} != $kind")
            val wantStatus = (ee["status"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.toInt()
            if (error.status != wantStatus) fail("$where error.status ${error.status} != $wantStatus")
            (ee["bodyContains"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.let { sub ->
                if (error.body?.contains(sub) != true) fail("$where error.body ${error.body} does not contain $sub")
            }
            if (kind != "non_retryable" && error.body != null) fail("$where error.body should be null for $kind")
        }

        val got = JsonArray(attempts.map {
            JsonObject(
                mapOf(
                    "deployment" to JsonPrimitive(it.deploymentId),
                    "group" to JsonPrimitive(it.group),
                    "outcome" to JsonPrimitive(it.outcome.value),
                    "status" to (it.status?.let { s -> JsonPrimitive(s) } ?: JsonNull),
                ),
            )
        })
        val wantAttempts = e.getValue("attempts")
        if (!jsonEquals(got, wantAttempts)) fail("$where attempts\n      expected $wantAttempts\n      actual   $got")

        val log = harness.log()
        val received = log.drop(seen)
        checkRequests(fail, where, received, attempts.map { it.deploymentId }, e, config)
        return log.size
    }

    private fun checkRequests(
        fail: (String) -> Unit,
        where: String,
        received: List<Received>,
        attemptIds: List<String>,
        expect: JsonObject,
        config: JsonObject,
    ) {
        // 불변식: 시도마다 정확히 한 요청, 경로와 body.model 이 그 배포의 것
        if (received.size != attemptIds.size) {
            fail("$where provider received ${received.size} requests, attempts ${attemptIds.size}")
            return
        }
        val deps = config.getValue("groups").jsonObject.values.flatMap { it.jsonObject.getValue("deployments").jsonArray.map { d -> d.jsonObject } }
        val providers = config.getValue("providers").jsonArray.map { it.jsonObject }
        attemptIds.forEachIndexed { i, id ->
            val d = deps.first { it.str("id") == id }
            val p = providers.first { it.str("id") == d.str("provider") }
            val wantPath = urlPath(p.str("baseUrl").trimEnd('/') + "/chat/completions")
            val r = received[i]
            if (r.path != wantPath) fail("$where request[$i] path ${r.path} != $wantPath")
            val model = (r.body as? JsonObject)?.get("model")
            if (!jsonEquals(model ?: JsonNull, JsonPrimitive(d.str("model")))) fail("$where request[$i] body.model $model != ${d.str("model")}")
        }
        val wantReqs = expect["requests"] as? JsonArray ?: return
        if (wantReqs.size != received.size) {
            fail("$where expected ${wantReqs.size} requests, got ${received.size}")
            return
        }
        wantReqs.forEachIndexed { i, erEl ->
            val er = erEl.jsonObject
            val r = received[i]
            (er["path"] as? JsonPrimitive)?.content?.let { if (r.path != it) fail("$where request[$i] path ${r.path} != $it") }
            (er["headers"] as? JsonObject)?.forEach { (k, v) ->
                val gotH = r.headers[k.lowercase()]
                if (gotH != v.jsonPrimitive.content) fail("$where request[$i] header $k: $gotH != $v")
            }
            (er["absentHeaders"] as? JsonArray)?.forEach { k ->
                if (k.jsonPrimitive.content.lowercase() in r.headers) fail("$where request[$i] header $k should be absent")
            }
            er["body"]?.let { if (!jsonEquals(r.body, it)) fail("$where request[$i] body\n      expected $it\n      actual   ${r.body}") }
        }
    }

    /** 취소 단계: cancelAfterMs 뒤(0 이면 호출 전에 이미) 취소. 반환: 새 로그 위치 */
    private suspend fun runCancelStep(
        fail: (String) -> Unit,
        where: String,
        router: Router,
        step: JsonObject,
        harness: Harness,
        seen: Int,
    ): Int {
        val cancelAfter = step.getValue("cancelAfterMs").jsonPrimitive.long
        var outcome = "not finished"
        val t0 = TimeSource.Monotonic.markNow()
        coroutineScope {
            val job = launch {
                if (cancelAfter == 0L) coroutineContext.cancel() // 이미 취소된 코루틴 안에서 호출
                try {
                    val r = router.route(step.str("group"), step.getValue("request").jsonObject)
                    outcome = "success via ${r.deploymentId}"
                } catch (x: RouterError) {
                    outcome = "RouterError ${x.kind}"
                } catch (x: CancellationException) {
                    outcome = "cancelled"
                    throw x
                } catch (x: Exception) {
                    outcome = "unexpected $x"
                }
            }
            if (cancelAfter > 0) {
                delay(cancelAfter)
                job.cancel()
            }
            job.join()
        }
        if (outcome != "cancelled") fail("$where expected CancellationException, got $outcome")
        val elapsed = t0.elapsedNow().inWholeMilliseconds
        if (elapsed > cancelAfter + 500) fail("$where cancellation took ${elapsed}ms")
        val log = harness.log()
        val received = log.drop(seen)
        val want = (step.getValue("expect").jsonObject["requests"] as? JsonArray).orEmpty()
        if (received.size != want.size) fail("$where provider received ${received.size} requests, expected ${want.size}")
        want.forEachIndexed { i, er ->
            val p = (er.jsonObject["path"] as? JsonPrimitive)?.content
            if (p != null && received.getOrNull(i)?.path != p) fail("$where request[$i] path ${received.getOrNull(i)?.path} != $p")
        }
        return log.size
    }

    private fun substitute(v: JsonElement, base: String): JsonElement = when (v) {
        is JsonObject -> JsonObject(v.mapValues { substitute(it.value, base) })
        is JsonArray -> JsonArray(v.map { substitute(it, base) })
        is JsonPrimitive -> if (v.isString) JsonPrimitive(v.content.replace(placeholder, base)) else v
    }
}

internal fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content

/** "http://host:port/a/b?q" → "/a/b" */
internal fun urlPath(url: String): String {
    val afterScheme = url.substringAfter("://", url)
    val slash = afterScheme.indexOf('/')
    val path = if (slash < 0) "/" else afterScheme.substring(slash)
    return path.substringBefore('?').substringBefore('#')
}

/** JSON 깊은 비교: 키 순서 무시, 숫자는 값으로 비교 */
internal fun jsonEquals(a: JsonElement, b: JsonElement): Boolean = when {
    a is JsonObject && b is JsonObject -> a.size == b.size && a.all { (k, v) -> b[k]?.let { jsonEquals(v, it) } == true }
    a is JsonArray && b is JsonArray -> a.size == b.size && a.indices.all { jsonEquals(a[it], b[it]) }
    a is JsonNull || b is JsonNull -> a is JsonNull && b is JsonNull
    a is JsonPrimitive && b is JsonPrimitive -> when {
        a.isString || b.isString -> a.isString == b.isString && a.content == b.content
        else -> {
            val x = a.content.toDoubleOrNull()
            val y = b.content.toDoubleOrNull()
            if (x != null && y != null) x == y else a.content == b.content
        }
    }
    else -> false
}
