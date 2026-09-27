package dev.freellmrouter

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assume.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.fail
import kotlin.time.TimeSource

/**
 * 실제 OpenRouter 스모크 (spec/live-smoke.md). OPENROUTER_API_KEY 환경변수가 있을 때만 돈다.
 *   OPENROUTER_API_KEY=... ./gradlew :router:jvmTest --tests '*LiveSmokeTest*'
 * 키는 환경변수에서만 읽고 어디에도 찍지 않는다.
 */
class LiveSmokeTest {
    @Test
    fun liveSmoke() = runBlocking {
        val key = System.getenv("OPENROUTER_API_KEY")
        if (key.isNullOrEmpty()) {
            println("LIVE SKIP OPENROUTER_API_KEY not set")
            assumeTrue("OPENROUTER_API_KEY not set", false)
        }
        val specDir = System.getenv("FLR_SPEC_DIR") ?: "../spec"
        val raw = Json.parseToJsonElement(File(specDir, "models.json").readText()).jsonObject
        val settings = (raw["settings"] as? JsonObject).orEmpty() + ("timeoutSeconds" to JsonPrimitive(20))
        val config = parseConfig(JsonObject(raw + ("settings" to JsonObject(settings))).toString())
        val request = Json.parseToJsonElement(
            """{"messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":256}""",
        ).jsonObject

        fun fmt(a: List<Attempt>) = a.joinToString(",") { "${it.deploymentId}:${it.outcome}${it.status?.let { s -> ":$s" } ?: ""}:${it.durationMs}ms" }
        var failed = false
        Router(config, mapOf("openrouter" to key!!)).use { router ->
            val done = withTimeoutOrNull(5 * 60 * 1000L) {
                for (group in listOf("fast", "chat")) {
                    val t0 = TimeSource.Monotonic.markNow()
                    try {
                        val r = router.route(group, request)
                        val content = (((r.response["choices"] as? kotlinx.serialization.json.JsonArray)?.getOrNull(0) as? JsonObject)
                            ?.get("message") as? JsonObject)?.get("content")
                        val text = ((content as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "").replace(Regex("\\s+"), " ").take(80)
                        println("LIVE $group ok deployment=${r.deploymentId} served_group=${r.group} ms=${t0.elapsedNow().inWholeMilliseconds} attempts=[${fmt(r.attempts)}] content=${JsonPrimitive(text)}")
                    } catch (e: RouterError) {
                        failed = true
                        println("LIVE $group FAIL kind=${e.kind} status=${e.status} ms=${t0.elapsedNow().inWholeMilliseconds} attempts=[${fmt(e.attempts)}]")
                    }
                }
                true
            }
            if (done == null) {
                println("LIVE TIMEOUT total>300s")
                failed = true
            }
        }
        if (failed) fail("live smoke failed")
    }
}
