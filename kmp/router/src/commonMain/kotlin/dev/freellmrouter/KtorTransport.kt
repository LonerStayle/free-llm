package dev.freellmrouter

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.content.TextContent

/**
 * 기본 transport. Android/JVM 은 OkHttp 엔진, Apple 은 Darwin 엔진 (SPEC 3.6 설정).
 * 재시도·리다이렉트·자체 타임아웃을 끈 클라이언트를 쓴다. 시간 초과는 [Router] 가 판정한다.
 */
class KtorTransport(private val client: HttpClient = createDefaultHttpClient()) : Transport, AutoCloseable {
    override suspend fun send(url: String, headers: Map<String, String>, body: String): TransportResponse {
        var contentType = ContentType.Application.Json
        val response = client.post(url) {
            for ((name, value) in headers) {
                // Ktor 는 Content-Type 을 헤더가 아니라 본문 타입으로 받는다
                if (name.equals(HttpHeaders.ContentType, ignoreCase = true)) contentType = ContentType.parse(value)
                else header(name, value)
            }
            setBody(TextContent(body, contentType))
        }
        return TransportResponse(response.status.value, response.bodyAsText())
    }

    override fun close() = client.close()
}

/** SPEC 3.6 표대로 설정한 플랫폼 기본 HTTP 클라이언트. */
expect fun createDefaultHttpClient(): HttpClient

/** 기본 now(): 절전 포함 단조 시계 (SPEC 1.2) */
internal expect fun defaultNowMs(): Long
