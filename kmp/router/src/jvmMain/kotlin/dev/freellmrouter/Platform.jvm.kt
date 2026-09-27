package dev.freellmrouter

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import java.util.concurrent.TimeUnit

// JVM(호스트 테스트용)
internal actual fun defaultNowMs(): Long = System.nanoTime() / 1_000_000

actual fun createDefaultHttpClient(): HttpClient = HttpClient(OkHttp) {
    followRedirects = false
    expectSuccess = false
    engine { config { noRetryNoRedirectNoTimeout() } }
}

internal fun okhttp3.OkHttpClient.Builder.noRetryNoRedirectNoTimeout() {
    retryOnConnectionFailure(false)
    followRedirects(false)
    followSslRedirects(false)
    connectTimeout(0, TimeUnit.MILLISECONDS)
    readTimeout(0, TimeUnit.MILLISECONDS)
    writeTimeout(0, TimeUnit.MILLISECONDS)
    callTimeout(0, TimeUnit.MILLISECONDS)
}
