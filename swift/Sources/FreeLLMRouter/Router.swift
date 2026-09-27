import Foundation

#if canImport(Darwin)
import Darwin
#endif

public struct RouterOptions: Sendable {
    /// nil 이면 `URLSessionTransport(requestTimeoutSeconds: timeoutSeconds + 5)`
    public var transport: (any Transport)?
    /// [0,1). nil 이면 플랫폼 난수
    public var rng: (@Sendable () -> Double)?
    /// 밀리초. nil 이면 절전 포함 단조 시계 (SPEC 1.2)
    public var now: (@Sendable () -> Int64)?

    public init(
        transport: (any Transport)? = nil,
        rng: (@Sendable () -> Double)? = nil,
        now: (@Sendable () -> Int64)? = nil
    ) {
        self.transport = transport
        self.rng = rng
        self.now = now
    }
}

/// 기본 now(): Darwin 의 CLOCK_MONOTONIC 은 절전 시간을 포함한다 (SPEC 1.2).
public func defaultNowMs() -> Int64 {
    Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000)
}

/// 폴백 라우터. 상태(실패 기록·쿨다운)는 이 actor 안, 메모리에만 둔다.
public actor Router {
    public nonisolated let config: Config
    private let keys: [String: String]
    private let transport: any Transport
    private let rng: @Sendable () -> Double
    private let now: @Sendable () -> Int64
    private var state: [String: DepState] = [:]

    private struct DepState {
        var failures: [Int64] = []
        var cooldownUntil: Int64?
    }

    public init(config: Config, keys: [String: String], options: RouterOptions = RouterOptions()) {
        self.config = config
        self.keys = keys
        self.transport = options.transport ?? URLSessionTransport(requestTimeoutSeconds: config.settings.timeoutSeconds + 5)
        self.rng = options.rng ?? { Double.random(in: 0..<1) }
        self.now = options.now ?? { defaultNowMs() }
    }

    /// 편의: models.json 형식 문자열에서 바로 만든다. 잘못되면 ConfigError.
    public init(configJSON: String, keys: [String: String], options: RouterOptions = RouterOptions()) throws {
        self.init(config: try parseConfig(configJSON), keys: keys, options: options)
    }

    // MARK: 공개 API

    /// 그룹 안에서 폴백하며 요청을 보낸다.
    /// - 실패: `RouterError`. Task 취소: `CancellationError` (RouterError 로 감싸지 않는다, SPEC 1.1)
    public func route(group: String, request: JSONObject) async throws -> RouteResult {
        guard let _ = config.groups[group] else {
            throw RouterError(kind: .invalidRequest, status: nil, body: nil, attempts: [], message: "unknown group: \(group)")
        }
        guard case .array? = request["messages"] else {
            throw RouterError(kind: .invalidRequest, status: nil, body: nil, attempts: [], message: "request.messages must be an array")
        }
        if request["stream"] == .bool(true) {
            throw RouterError(kind: .invalidRequest, status: nil, body: nil, attempts: [], message: "stream is not supported")
        }
        let tokens = estimateTokens(request)
        var attempted = Set<String>()
        var attempts: [Attempt] = []
        var visited = Set<String>()
        var visitOrder: [String] = []
        var queue = [group]
        var reasons: [GroupEnd] = []
        let s = config.settings
        while !queue.isEmpty {
            let g = queue.removeFirst()
            visited.insert(g)
            visitOrder.append(g)
            let r = try await runGroup(g, request, tokens, &attempted, &attempts)
            if case .success(let result) = r { return result }
            guard case .ended(let reason) = r else { continue }
            reasons.append(reason)
            let next = (reason == .context ? s.contextWindowFallbacks[g] : s.fallbacks[g]) ?? []
            for n in next where !visited.contains(n) && !queue.contains(n) { queue.append(n) }
        }
        let kind: ErrorKind = reasons.allSatisfy { $0 == .context } ? .contextWindowExceeded : .allFailed
        throw RouterError(kind: kind, status: nil, body: nil, attempts: attempts,
                          message: "all deployments failed (groups: \(visitOrder.joined(separator: " → ")))")
    }

    /// 설정의 모든 배포(비활성·키 없음 포함)의 상태. 진단·테스트용.
    public func deploymentStates() -> [String: DeploymentState] {
        let t = now()
        let window = config.settings.cooldownMs
        var out: [String: DeploymentState] = [:]
        for deps in config.groups.values {
            for d in deps {
                let st = state[d.id] ?? DepState()
                let cooling = isCoolingDown(d.id, t)
                out[d.id] = DeploymentState(
                    coolingDown: cooling,
                    cooldownUntilMs: cooling ? st.cooldownUntil : nil,
                    recentFailures: st.failures.filter { t - $0 < window }.count
                )
            }
        }
        return out
    }

    /// 모든 배포의 실패 기록·쿨다운을 비운다 (SPEC 1.4). 진행 중인 route 는 그대로 이어진다.
    public func resetState() {
        state.removeAll()
    }

    // MARK: 내부

    private enum GroupEnd { case context, retryable }
    private enum GroupResult { case success(RouteResult), ended(GroupEnd) }

    private func runGroup(
        _ g: String, _ request: JSONObject, _ tokens: Int,
        _ attempted: inout Set<String>, _ attempts: inout [Attempt]
    ) async throws -> GroupResult {
        let maxAttempts = 1 + config.settings.numRetries
        var n = 0
        var last: GroupEnd = .retryable
        var tokenExcludedAtStart = false
        while n < maxAttempts {
            try Task.checkCancellation()  // 매 시도 직전 (후보 계산·rng 전)
            let (cands, tokenExcluded) = candidates(g, tokens, attempted, now())
            if cands.isEmpty {
                if n == 0 { tokenExcludedAtStart = tokenExcluded }
                break
            }
            let d = pickWeighted(cands, rng)
            attempted.insert(d.id)
            n += 1
            let started = monotonicNanos()
            let r = try await send(d, request)
            let durationMs = Int64((monotonicNanos() &- started) / 1_000_000)

            let outcome: Outcome
            var status: Int?
            var message: String?
            var json: JSONObject?
            var text = ""
            switch r {
            case .response(let resp):
                (outcome, json) = classifyResponse(status: resp.status, text: resp.text)
                status = resp.status
                text = resp.text
            case .failed(let o, let m):
                outcome = o
                message = m
            }
            attempts.append(Attempt(deploymentId: d.id, group: g, outcome: outcome, status: status,
                                    durationMs: durationMs, message: message))
            switch outcome {
            case .ok:
                return .success(RouteResult(response: json ?? [:], deploymentId: d.id, group: g, attempts: attempts))
            case .fatalStatus:
                throw RouterError(kind: .nonRetryable, status: status, body: text, attempts: attempts,
                                  message: "\(d.id) returned \(status ?? 0)")
            case .contextExceeded:
                last = .context
            case .retryableStatus, .badBody, .timeout, .networkError:
                recordFailure(d.id, now())
                last = .retryable
            }
        }
        let reason: GroupEnd = n > 0 ? last : (tokenExcludedAtStart ? .context : .retryable)
        return .ended(reason)
    }

    private func key(_ providerId: String) -> String? {
        guard let k = keys[providerId], !k.isEmpty else { return nil }
        return k
    }

    private func isCoolingDown(_ id: String, _ t: Int64) -> Bool {
        guard let until = state[id]?.cooldownUntil else { return false }
        return t < until
    }

    private func recordFailure(_ id: String, _ t: Int64) {
        let window = config.settings.cooldownMs
        var st = state[id] ?? DepState()
        // 쿨다운 중 늦게 도착한 실패도 그대로 기록한다. 다시 allowedFails 에 닿으면 연장 (SPEC 1.3)
        st.failures = st.failures.filter { t - $0 < window }
        st.failures.append(t)
        if st.failures.count >= config.settings.allowedFails {
            st.cooldownUntil = t + window
            st.failures = []
        }
        state[id] = st
    }

    private func candidates(_ g: String, _ tokens: Int, _ attempted: Set<String>, _ t: Int64) -> ([Deployment], Bool) {
        var out: [Deployment] = []
        var tokenExcluded = false
        for d in config.groups[g] ?? [] {
            if !d.enabled { continue }
            if key(d.provider) == nil { continue }
            if isCoolingDown(d.id, t) { continue }
            if attempted.contains(d.id) { continue }
            if let m = d.maxInputTokens, tokens > m {
                tokenExcluded = true
                continue
            }
            out.append(d)
        }
        return (out, tokenExcluded)
    }

    private enum SendResult: Sendable {
        case response(TransportResponse)
        case failed(Outcome, String)
    }

    private func send(_ d: Deployment, _ request: JSONObject) async throws -> SendResult {
        let p = config.provider(d.provider)!
        var base = p.baseUrl
        while base.hasSuffix("/") { base.removeLast() }
        var headers = p.extraHeaders
        headers["Content-Type"] = "application/json"
        headers["Authorization"] = "Bearer \(key(d.provider) ?? "")"
        var body = request
        body["model"] = .string(d.model)
        let raced = try await raceTransport(
            transport, url: base + "/chat/completions", headers: headers,
            body: JSONValue.object(body).serialized(), timeoutMs: config.settings.timeoutMs
        )
        try Task.checkCancellation()  // transport 가 끝난 직후, 분류 전
        switch raced {
        case .response(let r): return .response(r)
        case .timeout: return .failed(.timeout, "timeout after \(config.settings.timeoutMs)ms")
        case .error(let e): return .failed(.networkError, String(describing: e))
        }
    }
}

// MARK: - 타임아웃·취소 경합

enum RaceResult: Sendable {
    case response(TransportResponse)
    case timeout
    case error(any Error)
}

/// transport 와 타이머, 호출자 취소 중 먼저 끝나는 것을 돌려준다. 진 쪽은 취소하고 기다리지 않는다.
/// 호출자 Task 가 취소되면 CancellationError 를 던진다(transport 가 URLError(.cancelled) 를 던져도 network_error 가 아니다).
func raceTransport(
    _ transport: any Transport, url: String, headers: [String: String], body: String, timeoutMs: Int64
) async throws -> RaceResult {
    try Task.checkCancellation()  // 이미 취소됐으면 요청을 시작하지 않는다
    let race = Race()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<RaceResult, Error>) in
            race.install(cont)
            race.add(Task {
                do {
                    let r = try await transport.send(url: url, headers: headers, body: body)
                    race.finish(.success(.response(r)))
                } catch {
                    race.finish(.success(.error(error)))
                }
            })
            race.add(Task {
                let ns = UInt64(max(0, timeoutMs)).multipliedReportingOverflow(by: 1_000_000)
                do {
                    try await Task.sleep(nanoseconds: ns.overflow ? UInt64.max : ns.partialValue)
                    race.finish(.success(.timeout))
                } catch {}  // 진 쪽이라 취소됨
            })
        }
    } onCancel: {
        race.finish(.failure(CancellationError()))
    }
}

private final class Race: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<RaceResult, Error>?
    private var result: Result<RaceResult, Error>?
    private var tasks: [Task<Void, Never>] = []

    func install(_ c: CheckedContinuation<RaceResult, Error>) {
        lock.lock()
        if let r = result {
            lock.unlock()
            c.resume(with: r)
        } else {
            cont = c
            lock.unlock()
        }
    }

    func add(_ t: Task<Void, Never>) {
        lock.lock()
        if result != nil {
            lock.unlock()
            t.cancel()
        } else {
            tasks.append(t)
            lock.unlock()
        }
    }

    func finish(_ r: Result<RaceResult, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = r
        let c = cont
        cont = nil
        let ts = tasks
        tasks = []
        lock.unlock()
        for t in ts { t.cancel() }
        c?.resume(with: r)
    }
}

private func monotonicNanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

// MARK: - 규칙 함수 (SPEC 3.1, 4절, 2절)

/// 3.1 토큰 추정: ceil(UTF-16 코드 유닛 수 / 4)
func estimateTokens(_ request: JSONObject) -> Int {
    var units = 0
    for m in request["messages"]?.arrayValue ?? [] {
        switch m["content"] {
        case .string(let s)?:
            units += s.utf16.count
        case .array(let parts)?:
            for part in parts {
                if case .string(let t)? = part["text"] { units += t.utf16.count }
            }
        default:
            break
        }
    }
    return (units + 3) / 4
}

func isRetryableStatus(_ status: Int) -> Bool {
    status == 404 || status == 408 || status == 429 || (500...599).contains(status)
}

/// ASCII A–Z 만 a–z 로. 로캘·유니코드 소문자화를 쓰지 않는다 (SPEC 4절).
func asciiLower(_ s: String) -> String {
    String(decoding: s.utf8.map { (0x41...0x5A).contains($0) ? $0 + 32 : $0 }, as: UTF8.self)
}

private let contextPatterns: [[UInt8]] = ["context length", "context_length", "maximum context", "too many tokens"]
    .map { Array($0.utf8) }

func isContextError(status: Int, text: String) -> Bool {
    guard status == 400 || status == 413 else { return false }
    // 바이트 단위 비교: 패턴이 ASCII 라 UTF-8 다중 바이트 안에서 잘못 맞을 일이 없다.
    let lower = text.utf8.map { (0x41...0x5A).contains($0) ? $0 + 32 : $0 }
    return contextPatterns.contains { containsBytes(lower, $0) }
}

private func containsBytes(_ hay: [UInt8], _ needle: [UInt8]) -> Bool {
    guard !needle.isEmpty, hay.count >= needle.count else { return needle.isEmpty }
    let first = needle[0]
    var i = 0
    let last = hay.count - needle.count
    while i <= last {
        if hay[i] == first {
            var j = 1
            while j < needle.count, hay[i + j] == needle[j] { j += 1 }
            if j == needle.count { return true }
        }
        i += 1
    }
    return false
}

func classifyResponse(status: Int, text: String) -> (Outcome, JSONObject?) {
    if (200...299).contains(status) {
        guard case .object(let json)? = try? JSONValue.parse(text) else { return (.badBody, nil) }
        if let e = json["error"], e != .null { return (.badBody, json) }
        guard case .array(let choices)? = json["choices"], !choices.isEmpty else { return (.badBody, json) }
        return (.ok, json)
    }
    if isContextError(status: status, text: text) { return (.contextExceeded, nil) }
    if isRetryableStatus(status) { return (.retryableStatus, nil) }
    return (.fatalStatus, nil)
}

func pickWeighted(_ cands: [Deployment], _ rng: () -> Double) -> Deployment {
    let total = cands.reduce(0.0) { $0 + Double($1.rpm) }
    let r = rng() * total
    var acc = 0.0
    for d in cands {
        acc += Double(d.rpm)
        if acc > r { return d }
    }
    return cands[cands.count - 1]
}
