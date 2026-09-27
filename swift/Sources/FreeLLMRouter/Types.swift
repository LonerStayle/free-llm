import Foundation

/// 시도 결과 종류 (SPEC 4절). rawValue 는 명세 문자열 그대로.
public enum Outcome: String, Sendable, CaseIterable {
    case ok = "ok"
    case retryableStatus = "retryable_status"
    case badBody = "bad_body"
    case timeout = "timeout"
    case networkError = "network_error"
    case contextExceeded = "context_exceeded"
    case fatalStatus = "fatal_status"
}

/// 최종 에러 종류 (SPEC 5절). rawValue 는 명세 문자열 그대로.
public enum ErrorKind: String, Sendable, CaseIterable {
    case invalidRequest = "invalid_request"
    case nonRetryable = "non_retryable"
    case contextWindowExceeded = "context_window_exceeded"
    case allFailed = "all_failed"
}

public struct Attempt: Sendable, Equatable {
    public let deploymentId: String
    public let group: String
    public let outcome: Outcome
    /// HTTP 응답을 받았으면 상태 코드. timeout·network_error 면 nil
    public let status: Int?
    /// 실제 경과 시간(단조 시계). 주입된 now 와 무관
    public let durationMs: Int64
    public let message: String?
}

public struct RouteResult: Sendable {
    /// 제공처 응답 JSON 전체
    public let response: JSONObject
    public let deploymentId: String
    /// 실제로 응답한 그룹 (폴백되면 요청 그룹과 다르다)
    public let group: String
    public let attempts: [Attempt]

    /// `choices[0].message.content` 가 문자열이면 그 값.
    public var content: String? { response["choices"]?[0]?["message"]?["content"]?.stringValue }
}

/// route 실패. 호출자 취소는 이 타입이 아니라 `CancellationError` 로 온다 (SPEC 1.1).
public struct RouterError: Error, Sendable, CustomStringConvertible {
    public let kind: ErrorKind
    public let status: Int?
    /// non_retryable 일 때 응답 본문 원문. 그 외 nil
    public let body: String?
    public let attempts: [Attempt]
    public let message: String

    public var description: String { "RouterError(\(kind.rawValue)): \(message)" }
}

public struct DeploymentState: Sendable, Equatable {
    public let coolingDown: Bool
    /// coolingDown 일 때만 값이 있다
    public let cooldownUntilMs: Int64?
    /// 실패 창(cooldownSeconds) 안의 실패 수
    public let recentFailures: Int
}

public struct TransportResponse: Sendable {
    public let status: Int
    /// 응답 본문 원문
    public let text: String
    public init(status: Int, text: String) {
        self.status = status
        self.text = text
    }
}

/// HTTP 한 번을 보내는 수단 (SPEC 1절, 3.6).
/// - 한 호출 = 정확히 한 번의 HTTP 요청. 스스로 재시도하거나 리다이렉트를 따라가지 않는다.
/// - 응답을 못 받으면(연결 실패·끊김) 예외를 던진다. 타임아웃은 라우터가 건다.
/// - Task 취소에 즉시 반응해야 한다.
public protocol Transport: Sendable {
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse
}
