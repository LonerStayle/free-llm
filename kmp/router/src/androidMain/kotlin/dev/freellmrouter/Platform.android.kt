package dev.freellmrouter

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import android.os.SystemClock
import java.util.concurrent.TimeUnit

// 절전 시간을 포함하는 시계
internal actual fun defaultNowMs(): Long = SystemClock.elapsedRealtime()

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
