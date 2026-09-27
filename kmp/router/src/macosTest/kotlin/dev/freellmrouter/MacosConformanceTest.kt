package dev.freellmrouter

import dev.freellmrouter.conformance.ConformanceDriver
import dev.freellmrouter.conformance.MockServer
import dev.freellmrouter.conformance.TestHost
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.readBytes
import kotlinx.coroutines.runBlocking
import platform.Foundation.NSFileHandle
import platform.Foundation.closeFile
import platform.Foundation.launch
import platform.Foundation.launchPath
import platform.Foundation.waitUntilExit
import platform.Foundation.NSPipe
import platform.Foundation.NSString
import platform.Foundation.NSTask
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.stringWithContentsOfFile
import platform.posix.getenv
import kotlinx.cinterop.toKString
import kotlin.test.Test

@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
private val macosHost = TestHost(
    readText = { path ->
        NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null) ?: error("cannot read $path")
    },
    env = { name -> getenv(name)?.toKString() },
)

/** node 모의 서버를 NSTask 로 띄운다. stdin 파이프가 닫히면 서버도 끝난다 (--exit-on-stdin-close). */
@OptIn(ExperimentalForeignApi::class)
private fun startMacosMockServer(specDir: String): MockServer? = try {
    val stdout = NSPipe()
    val stdin = NSPipe()
    val task = NSTask()
    task.launchPath = "/usr/bin/env"
    val node = getenv("FLR_NODE")?.toKString() ?: "node"
    task.arguments = listOf(node, "$specDir/mock-server/server.mjs", "--port", "0", "--exit-on-stdin-close")
    task.standardOutput = stdout
    task.standardInput = stdin
    task.launch()
    val line = readLine(stdout.fileHandleForReading)
    val url = Regex("\"url\"\\s*:\\s*\"([^\"]+)\"").find(line)?.groupValues?.get(1) ?: error("no url in '$line'")
    MockServer(url) {
        stdin.fileHandleForWriting.closeFile()
        if (task.isRunning()) task.terminate()
        task.waitUntilExit()
    }
} catch (e: Throwable) {
    println("could not start mock server: $e")
    null
}

@OptIn(ExperimentalForeignApi::class)
private fun readLine(h: NSFileHandle): String {
    val buf = StringBuilder()
    while (!buf.contains('\n')) {
        val data = h.availableData
        if (data.length.toInt() == 0) break // EOF
        buf.append(data.bytes!!.readBytes(data.length.toInt()).decodeToString())
    }
    return buf.toString().substringBefore('\n')
}

class MacosConformanceTest {
    private val driver = ConformanceDriver(macosHost, ::startMacosMockServer)

    @Test
    fun memoryTransport() = runBlocking { driver.memory() }

    @Test
    fun mockServerHttpDarwin() = runBlocking { driver.http("darwin") }

    @Test
    fun configCasesAndModelsJson() = driver.configCases()
}
