package dev.freellmrouter.conformance

import kotlinx.serialization.json.JsonObject
import kotlin.test.fail

/**
 * 플랫폼 테스트(jvmTest, macosTest)가 부르는 진입점.
 * [startMock] 은 모의 서버를 띄우지 못하면 null (FLR_MOCK_URL 이 있으면 부르지 않는다).
 */
class ConformanceDriver(private val host: TestHost, private val startMock: (specDir: String) -> MockServer?) {
    private val conf by lazy { Conformance(host) }

    suspend fun memory() {
        val report = conf.runMode("memory") { c -> MemoryHarness(c["responses"] as? JsonObject ?: JsonObject(emptyMap())) }
        assertReport(report)
    }

    suspend fun http(engineName: String) {
        val given = host.env("FLR_MOCK_URL")?.takeIf { it.isNotEmpty() }?.trimEnd('/')
        val server = if (given != null) MockServer(given) {} else startMock(conf.specDir)
        if (server == null) {
            val msg = "HTTP MODE SKIPPED: no FLR_MOCK_URL and could not start node mock server"
            println("\n" + "!".repeat(msg.length) + "\n$msg\n" + "!".repeat(msg.length))
            if (!host.env("FLR_REQUIRE_HTTP").isNullOrEmpty()) fail(msg)
            return
        }
        println("mock server: ${server.url} (engine: $engineName)")
        val harness = HttpHarness(server.url)
        try {
            assertReport(conf.runMode("http/$engineName") { harness })
        } finally {
            harness.close()
            server.stop()
        }
    }

    fun configCases() {
        val failures = conf.checkModelsJson() + conf.runConfigCases()
        println("models.json: ${if (conf.checkModelsJson().isEmpty()) "ok (parseConfig)" else "FAIL"}")
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
        if (conf.configCases.isEmpty() && conf.cases.isEmpty()) fail("no case matches FLR_CASE")
    }

    private fun assertReport(r: ModeReport) {
        if (r.results.isEmpty() && conf.configCases.isEmpty()) fail("no case matches FLR_CASE")
        if (r.failed.isNotEmpty()) {
            fail("[${r.mode}] ${r.failed.size} failed: " + r.failed.joinToString("; ") { "${it.name}: ${it.failures.first()}" })
        }
    }
}
