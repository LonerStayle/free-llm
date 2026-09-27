package dev.freellmrouter

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RouterUnitTest {
    private fun config(timeoutSeconds: Double = 5.0, allowedFails: Int = 3) = parseConfig(
        """
        {"providers":[{"id":"p1","baseUrl":"http://x.invalid/p1/"}],
         "groups":{"chat":{"deployments":[{"id":"a","provider":"p1","model":"m-a","rpm":1}]}},
         "settings":{"timeoutSeconds":$timeoutSeconds,"allowedFails":$allowedFails}}
        """.trimIndent(),
    )

    private val hi: JsonObject = Json.parseToJsonElement("""{"messages":[{"role":"user","content":"hi"}]}""").jsonObject

    private class FakeIOException(msg: String) : Exception(msg)

    @Test
    fun asciiLowerOnlyTouchesAsciiLetters() {
        assertEquals("context length", asciiLower("CONTEXT LENGTH"))
        assertEquals("İK x", asciiLower("İK X")) // İ, 켈빈 기호는 그대로
        assertTrue(isContextError(400, "Maximum Context exceeded"))
        // 켈빈 기호(U+212A)는 유니코드 소문자화면 k 가 되지만 ASCII 소문자화로는 그대로다
        assertFalse(isContextError(413, "TOO MANY TO\u212AENS"))
        assertTrue(isContextError(413, "TOO MANY TOKENS"))
    }

    @Test
    fun secondsToMsRoundsHalfUp() {
        assertEquals(3L, secondsToMs(0.0025)) // 2.5ms → 3 (짝수 반올림이면 2)
        assertEquals(300L, secondsToMs(0.3))
        assertEquals(60_000L, secondsToMs(60.0))
    }

    @Test
    fun tokenEstimateCountsUtf16Units() {
        val messages = Json.parseToJsonElement(
            """[{"content":"😀한글"},{"content":[{"type":"text","text":"ab"},{"type":"image_url"}]},{"content":null},"x"]""",
        ).jsonArray
        // 😀(2) + 한글(2) + ab(2) = 6 → ceil(6/4) = 2
        assertEquals(2L, estimateTokens(messages))
    }

    @Test
    fun weightedPickUsesRemainingTotal() {
        val d = { id: String, rpm: Int -> Deployment(id, "p", id, rpm, null, true) }
        val list = listOf(d("a", 1), d("b", 3))
        assertEquals("a", pickWeighted(list) { 0.2 }.id) // r = 0.8 < 1
        assertEquals("b", pickWeighted(list) { 0.25 }.id) // r = 1.0, acc 1 > 1 아님
        assertEquals("b", pickWeighted(list) { 0.9999999 }.id)
    }

    @Test
    fun transportIOExceptionAfterCallerCancelIsCancellationNotNetworkError() = runTest {
        // OkHttp 처럼 취소를 IOException("Canceled") 로 바꿔 던지는 transport
        val transport = Transport { _, _, _ ->
            try {
                awaitCancellation()
            } catch (e: CancellationException) {
                throw FakeIOException("Canceled")
            }
        }
        val router = Router(config(), mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        var caught: Throwable? = null
        val job = launch {
            try {
                router.route("chat", hi)
            } catch (e: Throwable) {
                caught = e
                throw e
            }
        }
        delay(100)
        job.cancel()
        job.join()
        assertTrue(caught is CancellationException, "got $caught")
        assertEquals(0, router.deploymentStates().getValue("a").recentFailures)
    }

    @Test
    fun routerTimeoutWinsEvenIfTransportConvertsCancellation() = runTest {
        val transport = Transport { _, _, _ ->
            try {
                delay(10_000)
                TransportResponse(200, "{}")
            } catch (e: CancellationException) {
                throw FakeIOException("Canceled")
            }
        }
        val router = Router(config(timeoutSeconds = 0.05), mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        val e = assertFailsWith<RouterError> { router.route("chat", hi) }
        assertEquals(ErrorKind.ALL_FAILED, e.kind)
        assertEquals(listOf(Outcome.TIMEOUT), e.attempts.map { it.outcome })
        assertEquals(null, e.attempts.single().status)
        assertEquals(1, router.deploymentStates().getValue("a").recentFailures)
    }

    @Test
    fun cancellationFromTransportIsRethrown() = runTest {
        val transport = Transport { _, _, _ -> throw CancellationException("stop") }
        val router = Router(config(), mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        assertFailsWith<CancellationException> { router.route("chat", hi) }
        assertEquals(0, router.deploymentStates().getValue("a").recentFailures)
    }

    @Test
    fun requestBodyKeepsFieldsAndOverridesModel() = runTest {
        var sentUrl = ""
        var sentBody = ""
        var sentHeaders = emptyMap<String, String>()
        val transport = Transport { url, headers, body ->
            sentUrl = url
            sentHeaders = headers
            sentBody = body
            TransportResponse(200, """{"choices":[{"message":{"content":"x"}}]}""")
        }
        val router = Router(config(), mapOf("p1" to "key"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        val req = Json.parseToJsonElement("""{"model":"caller","messages":[],"future_field":{"x":[1,2.5]}}""").jsonObject
        val r = router.route("chat", req)
        assertEquals("a", r.deploymentId)
        assertEquals("http://x.invalid/p1/chat/completions", sentUrl)
        assertEquals("Bearer key", sentHeaders["Authorization"])
        assertEquals(
            Json.parseToJsonElement("""{"model":"m-a","messages":[],"future_field":{"x":[1,2.5]}}"""),
            Json.parseToJsonElement(sentBody),
        )
    }

    @Test
    fun concurrentFailuresAreAllRecorded() = runTest {
        val transport = Transport { _, _, _ -> TransportResponse(429, "{}") }
        val router = Router(config(allowedFails = 100_000), mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        withContext(Dispatchers.Default) {
            (1..500).map { async { runCatching { router.route("chat", hi) } } }.awaitAll()
        }
        assertEquals(500, router.deploymentStates().getValue("a").recentFailures)
        router.resetState()
        assertEquals(DeploymentState(false, null, 0), router.deploymentStates().getValue("a"))
    }

    @Test
    fun enumStringValuesMatchSpec() {
        assertEquals(
            listOf("ok", "retryable_status", "bad_body", "timeout", "network_error", "context_exceeded", "fatal_status"),
            Outcome.entries.map { it.value },
        )
        assertEquals(
            listOf("invalid_request", "non_retryable", "context_window_exceeded", "all_failed"),
            ErrorKind.entries.map { it.toString() },
        )
    }

    @Test
    fun strictJsonMatchesJsonParse() {
        // 기대값은 node JSON.parse 결과 (참조 구현과 같게)
        val bad = listOf(
            """{"choices":[abc]}""", """{"choices":[01]}""", """{"choices":[NaN]}""", "[Infinity]", "[-]", "[1.]", "[.5]",
            "[+1]", "[1e]", "[1e+]", "[True]", "[nul]", """{"a":1,}""", "[1,]", "{'a':1}", "{a:1}", "\"a\u0001b\"",
            """"\x"""", """"\u00g0"""", "{} x", " {}", "\u000c{}", "﻿{}", "", "  ", "[1 2]", """{"a" 1}""",
            """{"a":1 "b":2}""", """["a",]""", "{,}", "[,1]", "[", """{"a":""", "\"abc",
        )
        val good = listOf(
            """{"choices":[{"message":{"content":"hi"}}]}""",
            " \t\n\r" + """{"a":[1,-0,0.5,-1.5e10,2E-3,true,false,null,"é\n\"\\\/"]}""" + " \n",
            "[[[[]]]]", """{"a":{"b":{}}}""", """"\uD800"""", "-0", "0", "1e400", """{"a":1,"a":2}""", """["한글 🎉"]""",
            "[".repeat(MAX_JSON_DEPTH) + "]".repeat(MAX_JSON_DEPTH),
            "{\"a\":".repeat(MAX_JSON_DEPTH) + "1" + "}".repeat(MAX_JSON_DEPTH),
        )
        // 너무 깊은 중첩은 스택 넘침 대신 거부 (JSON.parse 와 다른 유일한 점)
        assertTrue(isStrictJson("[".repeat(5000) + "]".repeat(5000), maxDepth = 10_000))
        assertFalse(isStrictJson("[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1)))
        assertEquals(Outcome.BAD_BODY, classifyResponse(200, "{\"choices\":" + "[".repeat(100_000) + "]".repeat(100_000) + "}").outcome)
        for (t in bad) {
            assertFalse(isStrictJson(t), "should reject: $t")
            assertFailsWith<IllegalArgumentException>(t) { parseStrictJson(t) }
        }
        for (t in good) {
            assertTrue(isStrictJson(t), "should accept: $t")
            parseStrictJson(t)
        }
        assertEquals(Outcome.BAD_BODY, classifyResponse(200, """{"choices":[abc]}""").outcome)
        assertEquals(Outcome.OK, classifyResponse(200, """{"choices":[1]}""").outcome)
        assertFailsWith<ConfigError> { parseConfig("""{"providers":[],"groups":{},"x":abc}""") }
        assertFailsWith<ConfigError> { parseConfig("""{"version":01,"providers":[],"groups":{}}""") }
        parseConfig("""{"version":1,"providers":[],"groups":{}}""")
    }

    @Test
    fun saturatingAddDoesNotOverflow() {
        assertEquals(Long.MAX_VALUE, saturatingAdd(5L, Long.MAX_VALUE))
        assertEquals(15L, saturatingAdd(5L, 10L))
    }

    @Test
    fun hugeCooldownStillCoolsDown() = runTest {
        val cfg = parseConfig(
            """
            {"providers":[{"id":"p1","baseUrl":"http://x.invalid/"}],
             "groups":{"chat":{"deployments":[{"id":"a","provider":"p1","model":"m","rpm":1}]}},
             "settings":{"allowedFails":1,"numRetries":0,"cooldownSeconds":1e300}}
            """.trimIndent(),
        )
        val transport = Transport { _, _, _ -> TransportResponse(500, "") }
        val router = Router(cfg, mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 1_000L }))
        assertFailsWith<RouterError> { router.route("chat", hi) }
        assertTrue(router.deploymentStates().getValue("a").coolingDown)
    }

    @Test
    fun tinyTimeoutStillSendsOneRequest() = runTest {
        val cfg = parseConfig(
            """
            {"providers":[{"id":"p1","baseUrl":"http://x.invalid/"}],
             "groups":{"chat":{"deployments":[{"id":"a","provider":"p1","model":"m","rpm":1}]}},
             "settings":{"numRetries":0,"timeoutSeconds":0.0001}}
            """.trimIndent(),
        )
        var calls = 0
        val transport = Transport { _, _, _ ->
            calls++
            awaitCancellation()
        }
        val router = Router(cfg, mapOf("p1" to "k"), RouterOptions(transport = transport, rng = { 0.0 }, now = { 0L }))
        val e = assertFailsWith<RouterError> { router.route("chat", hi) }
        assertEquals(1, calls)
        assertEquals(listOf(Outcome.TIMEOUT), e.attempts.map { it.outcome })
    }
}
