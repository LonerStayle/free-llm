package dev.freellmrouter.conformance

import dev.freellmrouter.Transport
import dev.freellmrouter.TransportResponse
import dev.freellmrouter.createDefaultHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.content.TextContent
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

const val MEMORY_BASE = "http://mock.invalid"

/** 모의 서버 ScriptBook 을 옮긴 것 (spec/mock-server/server.mjs). 두 모드의 응답이 같다. */
class ScriptBook(private val responses: JsonObject) {
    private val used = HashMap<String, Int>()
    private var seq = 0

    class Entry(val status: Int, val text: String, val delayMs: Long, val bodyDelayMs: Long, val close: Boolean)

    fun next(model: String): Entry {
        val list = (responses[model] as? JsonArray).orEmpty()
        val i = used[model] ?: 0
        used[model] = i + 1
        seq++
        val e = (if (i < list.size) list[i] else null) as? JsonObject ?: JsonObject(emptyMap())
        val status = (e["status"] as? JsonPrimitive)?.content?.toDouble()?.toInt() ?: 200
        val body = e["body"]
        val text = when {
            body == null -> if (status in 200..299) defaultCompletion(model, seq) else
                """{"error":{"message":"mock status $status","code":$status}}"""
            body is JsonPrimitive && body.isString -> body.content
            else -> body.toString()
        }
        fun ms(k: String) = (e[k] as? JsonPrimitive)?.content?.toDouble()?.toLong() ?: 0L
        val close = (e["action"] as? JsonPrimitive)?.content == "close"
        return Entry(status, text, ms("delayMs"), ms("bodyDelayMs"), close)
    }

    private fun defaultCompletion(model: String, seq: Int): String {
        val m = JsonPrimitive(model).toString()
        val content = JsonPrimitive("ok:$model").toString()
        return """{"id":"mock-$seq","object":"chat.completion","created":0,"model":$m,""" +
            """"choices":[{"index":0,"message":{"role":"assistant","content":$content},"finish_reason":"stop"}],""" +
            """"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"""
    }
}

class ConnectionClosed : Exception("connection closed")

/** 메모리 가짜 transport. delayMs·bodyDelayMs 는 실제로(취소 가능하게) 기다린다 (SPEC 8.1). */
class MemoryHarness(responses: JsonObject) : Harness {
    private val book = ScriptBook(responses)
    private val requests = ArrayList<Received>()
    override val base = MEMORY_BASE

    override val transport = Transport { url, headers, body ->
        val parsed: JsonElement = try {
            Json.parseToJsonElement(body)
        } catch (e: Exception) {
            JsonPrimitive(body)
        }
        requests += Received(urlPath(url), headers.mapKeys { it.key.lowercase() }, parsed)
        val model = when (val m = (parsed as? JsonObject)?.get("model")) {
            null -> "undefined"
            is JsonPrimitive -> m.content
            else -> m.toString()
        }
        val r = book.next(model)
        if (r.delayMs > 0) delay(r.delayMs)
        if (r.close) throw ConnectionClosed()
        if (r.bodyDelayMs > 0) delay(r.bodyDelayMs) // 본문 끝까지 받아야 응답이 완성된다
        TransportResponse(r.status, r.text)
    }

    override suspend fun load(responses: JsonObject) {}

    override suspend fun log(): List<Received> = requests.toList()
}

/** 모의 서버 경유 실제 HTTP. 라우터는 기본 transport(플랫폼 엔진)를 쓴다 (SPEC 8.2). */
class HttpHarness(private val serverUrl: String) : Harness, AutoCloseable {
    private val control: HttpClient = createDefaultHttpClient()
    override val base = serverUrl
    override val transport: Transport? = null

    override suspend fun load(responses: JsonObject) {
        val body = JsonObject(mapOf("responses" to responses)).toString()
        val r = control.post("$serverUrl/__scenario") { setBody(TextContent(body, ContentType.Application.Json)) }
        check(r.status.value == 200) { "/__scenario -> ${r.status.value} ${r.bodyAsText()}" }
    }

    override suspend fun log(): List<Received> {
        val text = control.get("$serverUrl/__log").bodyAsText()
        return Json.parseToJsonElement(text).jsonObject.getValue("requests").jsonArray.map { el ->
            val o = el.jsonObject
            val headers = (o["headers"] as? JsonObject).orEmpty().mapValues { (_, v) ->
                when (v) {
                    is JsonPrimitive -> v.content
                    is JsonArray -> v.joinToString(", ") { it.jsonPrimitive.content }
                    else -> v.toString()
                }
            }
            Received(o.getValue("path").jsonPrimitive.content, headers, o["body"] ?: JsonNull)
        }
    }

    override fun close() = control.close()
}

/** 띄운 모의 서버 (또는 FLR_MOCK_URL 로 받은 서버). */
class MockServer(val url: String, private val onStop: () -> Unit) {
    fun stop() = onStop()
}
