package dev.freellmrouter

import kotlinx.serialization.json.JsonObject

/** 시도 결과 (SPEC 4절). [value] 는 명세 문자열 그대로. */
enum class Outcome(val value: String) {
    OK("ok"),
    RETRYABLE_STATUS("retryable_status"),
    BAD_BODY("bad_body"),
    TIMEOUT("timeout"),
    NETWORK_ERROR("network_error"),
    CONTEXT_EXCEEDED("context_exceeded"),
    FATAL_STATUS("fatal_status");

    override fun toString(): String = value
}

/** 최종 에러 종류 (SPEC 5절). [value] 는 명세 문자열 그대로. */
enum class ErrorKind(val value: String) {
    INVALID_REQUEST("invalid_request"),
    NON_RETRYABLE("non_retryable"),
    CONTEXT_WINDOW_EXCEEDED("context_window_exceeded"),
    ALL_FAILED("all_failed");

    override fun toString(): String = value
}

data class Attempt(
    val deploymentId: String,
    val group: String,
    val outcome: Outcome,
    /** HTTP 응답을 받았으면 상태 코드, timeout·network_error 면 null */
    val status: Int?,
    /** 실제 경과 시간(플랫폼 단조 시계). 주입된 now 와 무관 */
    val durationMs: Long,
    val message: String?,
)

data class RouteResult(
    /** 제공처 응답 JSON 전체 */
    val response: JsonObject,
    val deploymentId: String,
    /** 실제로 응답한 그룹 (폴백되면 요청 그룹과 다르다) */
    val group: String,
    val attempts: List<Attempt>,
)

data class DeploymentState(
    val coolingDown: Boolean,
    val cooldownUntilMs: Long?,
    val recentFailures: Int,
)

/** 라우팅 실패. 호출자 취소는 이 예외가 아니라 CancellationException 이다 (SPEC 1.1). */
class RouterError(
    val kind: ErrorKind,
    message: String,
    val status: Int? = null,
    val body: String? = null,
    val attempts: List<Attempt> = emptyList(),
) : Exception(message)

/** parseConfig 가 설정을 거부할 때 (SPEC 6절). */
class ConfigError(message: String) : Exception(message)

data class TransportResponse(val status: Int, val text: String)

/**
 * 한 번 호출 = 정확히 한 번의 HTTP POST. 스스로 재시도·리다이렉트·타임아웃하지 않는다 (SPEC 3.6).
 * 응답을 못 받으면 예외를 던진다. 취소는 코루틴 취소로 전달된다.
 */
fun interface Transport {
    suspend fun send(url: String, headers: Map<String, String>, body: String): TransportResponse
}

/**
 * @param transport 기본: 플랫폼 HTTP 클라이언트 ([KtorTransport])
 * @param rng [0,1) 난수. 기본: 플랫폼 난수
 * @param now 밀리초 시계. 기본: 절전 포함 단조 시계 (SPEC 1.2)
 */
data class RouterOptions(
    val transport: Transport? = null,
    val rng: (() -> Double)? = null,
    val now: (() -> Long)? = null,
)
