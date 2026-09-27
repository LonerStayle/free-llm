package dev.freellmrouter

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import platform.posix.CLOCK_MONOTONIC
import platform.posix.clock_gettime_nsec_np

// Darwin 의 CLOCK_MONOTONIC 은 절전 시간을 포함한다 (SPEC 1.2)
internal actual fun defaultNowMs(): Long = (clock_gettime_nsec_np(CLOCK_MONOTONIC.toUInt()) / 1_000_000uL).toLong()

// URLSession 은 타임아웃을 끌 수 없으므로 충분히 길게 둔다 (라우터 timeoutSeconds + 5초 이상)
private const val PLATFORM_TIMEOUT_SECONDS = 7.0 * 24 * 60 * 60

actual fun createDefaultHttpClient(): HttpClient = HttpClient(Darwin) {
    followRedirects = false
    expectSuccess = false
    engine {
        configureSession {
            setTimeoutIntervalForRequest(PLATFORM_TIMEOUT_SECONDS)
            setTimeoutIntervalForResource(PLATFORM_TIMEOUT_SECONDS)
        }
        configureRequest { setTimeoutInterval(PLATFORM_TIMEOUT_SECONDS) }
    }
}
