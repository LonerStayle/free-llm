// 게이트웨이 호출 예제. 의존성: com.squareup.okhttp3:okhttp, org.json (안드로이드 기본 포함)
// BASE_URL / GATEWAY_KEY 는 local.properties → BuildConfig 로 넣는다 (README 참고). 코드에 직접 쓰지 않는다.
package com.example.ai

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class GatewayClient(
    private val baseUrl: String = BuildConfig.GATEWAY_URL,   // 예: http://10.0.2.2:4100
    private val key: String = BuildConfig.GATEWAY_KEY,
) {
    // 무료 모델은 재시도·폴백 때문에 응답이 수십 초 걸릴 수 있다.
    private val http = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    /** model: "chat" 또는 "fast" (config.yaml 의 그룹 이름) */
    suspend fun ask(prompt: String, model: String = "chat"): String = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("model", model)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
            .toString()
            .toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url("$baseUrl/v1/chat/completions")
            .header("Authorization", "Bearer $key")
            .post(body)
            .build()

        http.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            check(res.isSuccessful) { "gateway ${res.code}: $text" }
            JSONObject(text).getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").getString("content")
        }
    }
}
