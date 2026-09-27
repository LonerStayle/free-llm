package dev.freellmrouter

import dev.freellmrouter.conformance.ConformanceDriver
import dev.freellmrouter.conformance.MockServer
import dev.freellmrouter.conformance.TestHost
import kotlinx.coroutines.runBlocking
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.test.Test

internal val jvmHost = TestHost(readText = { File(it).readText() }, env = { System.getenv(it) })

/** node 모의 서버를 자식 프로세스로 띄운다. stdin 파이프가 닫히면 서버도 끝난다 (--exit-on-stdin-close). */
internal fun startJvmMockServer(specDir: String): MockServer? = try {
    val node = System.getenv("FLR_NODE") ?: "node"
    val p = ProcessBuilder(node, "$specDir/mock-server/server.mjs", "--port", "0", "--exit-on-stdin-close")
        .redirectError(ProcessBuilder.Redirect.INHERIT)
        .start()
    val line = p.inputStream.bufferedReader().readLine() ?: error("mock server printed nothing")
    val url = Regex("\"url\"\\s*:\\s*\"([^\"]+)\"").find(line)?.groupValues?.get(1) ?: error("no url in $line")
    MockServer(url) {
        runCatching { p.outputStream.close() }
        p.destroy()
        if (!p.waitFor(3, TimeUnit.SECONDS)) p.destroyForcibly()
    }
} catch (e: Exception) {
    println("could not start mock server: $e")
    null
}

class JvmConformanceTest {
    private val driver = ConformanceDriver(jvmHost, ::startJvmMockServer)

    @Test
    fun memoryTransport() = runBlocking { driver.memory() }

    @Test
    fun mockServerHttpOkHttp() = runBlocking { driver.http("okhttp") }

    @Test
    fun configCasesAndModelsJson() = driver.configCases()
}
