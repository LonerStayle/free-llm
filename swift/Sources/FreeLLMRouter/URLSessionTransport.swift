import Foundation

/// 기본 transport (SPEC 3.6 의 URLSession 설정).
/// - 자체 타임아웃은 `requestTimeoutSeconds`(라우터는 timeoutSeconds + 5 를 넘긴다). 판정은 라우터 타이머가 한다.
/// - 리다이렉트는 delegate 에서 거부 → 3xx 응답을 그대로 돌려준다(라우터가 fatal_status 로 분류).
/// - 캐시·쿠키를 쓰지 않는다.
public final class URLSessionTransport: Transport {
    private let session: URLSession
    private let requestTimeout: TimeInterval

    public init(requestTimeoutSeconds: Double) {
        requestTimeout = requestTimeoutSeconds
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = requestTimeoutSeconds
        cfg.timeoutIntervalForResource = requestTimeoutSeconds
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    deinit {
        session.finishTasksAndInvalidate()  // delegate 순환 참조 해제
    }

    public func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        guard let u = URL(string: url) else { throw URLError(.badURL) }
        var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: requestTimeout)
        req.httpMethod = "POST"
        req.httpBody = Data(body.utf8)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // Task 취소 시 URLSession 은 URLError(.cancelled) 를 던진다. 분류는 라우터가 한다(1.1).
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return TransportResponse(status: http.statusCode, text: decodeBody(data))
    }
}

/// 응답 본문 → 문자열. fetch 의 `res.text()` 처럼 UTF-8 로 읽고 앞의 BOM(EF BB BF)은 뗀다.
func decodeBody(_ data: Data) -> String {
    let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
    if data.starts(with: bom) { return String(decoding: data.dropFirst(3), as: UTF8.self) }
    return String(decoding: data, as: UTF8.self)
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
