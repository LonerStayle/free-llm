import XCTest
@testable import FreeLLMRouter

final class JSONValueTests: XCTestCase {
    func testRoundTripAndNumbers() throws {
        let v = try JSONValue.parse(#"{"a":[1,2.5,-0.2,1e3,true,null,"x\n\"é😀"],"b":{}}"#)
        XCTAssertEqual(v["a"]?[0], .number(1))
        XCTAssertEqual(v["a"]?[3], .number(1000))
        XCTAssertEqual(v["a"]?[6]?.stringValue, "x\n\"é😀")
        XCTAssertEqual(try JSONValue.parse(v.serialized()), v)
        XCTAssertEqual(JSONValue.number(50).serialized(), "50")
        XCTAssertEqual(JSONValue.number(0.2).serialized(), "0.2")
        XCTAssertEqual(JSONValue.string("\u{01}").serialized(), #""\u0001""#)
    }

    func testLoneSurrogateBecomesReplacement() throws {
        XCTAssertEqual(try JSONValue.parse(#""\ud800x""#).stringValue, "\u{FFFD}x")
    }

    func testRejectsInvalid() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", "tru", "\"a", "[1] x", "NaN", "{'a':1}"] {
            XCTAssertThrowsError(try JSONValue.parse(bad), bad)
        }
    }
}

final class RuleTests: XCTestCase {
    func testAsciiLowerOnly() {
        XCTAssertEqual(asciiLower("CONTEXT İ \u{212A}"), "context İ \u{212A}")
        XCTAssertTrue(isContextError(status: 400, text: #"{"error":{"code":"CONTEXT_LENGTH_exceeded"}}"#))
        XCTAssertFalse(isContextError(status: 400, text: "Context \u{212A}ength"))
        XCTAssertFalse(isContextError(status: 500, text: "context length"))
    }

    func testTokenEstimateUsesUTF16() {
        let req: JSONObject = ["messages": [["role": "user", "content": "😀한"], ["content": [["text": "ab"], ["type": "image_url"]]], ["content": nil]]]
        // 😀 = 2, 한 = 1, ab = 2 → 5 units → 2 tokens
        XCTAssertEqual(estimateTokens(req), 2)
    }

    func testMsRounding() {
        XCTAssertEqual(Settings.toMs(0.0005), 1)
        XCTAssertEqual(Settings.toMs(0.3), 300)
        XCTAssertEqual(Settings.toMs(1e300), 1_000_000_000_000_000)
    }

    func testDefaultClockIsMonotonicMs() {
        let a = defaultNowMs()
        XCTAssertGreaterThan(a, 0)
        XCTAssertGreaterThanOrEqual(defaultNowMs(), a)
    }
}

// MARK: - 취소·타임아웃·동시성 (SPEC 1.1, 1.3, 3.6)

private let oneDeployment = """
{"providers":[{"id":"p","baseUrl":"http://t.invalid/p/"}],
 "groups":{"chat":{"deployments":[{"id":"a","provider":"p","model":"m","rpm":1}]}},
 "settings":{"allowedFails":100,"timeoutSeconds":TIMEOUT}}
"""

private func router(_ t: any Transport, timeout: Double = 5) throws -> Router {
    try Router(configJSON: oneDeployment.replacingOccurrences(of: "TIMEOUT", with: "\(timeout)"),
               keys: ["p": "k"], options: RouterOptions(transport: t, rng: { 0 }, now: { 1_000 }))
}

private let hi: JSONObject = ["messages": [["role": "user", "content": "hi"]]]

/// 취소를 무시하고 오래 붙잡는 transport (라우터가 기다리지 않는지 본다)
private struct StubbornTransport: Transport {
    let seconds: Double
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { c.resume() }
        }
        return TransportResponse(status: 200, text: #"{"choices":[{}]}"#)
    }
}

/// URLSession 처럼 Task 취소 시 URLError(.cancelled) 를 던지는 transport
private struct URLErrorOnCancel: Transport {
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { throw URLError(.cancelled) }
        return TransportResponse(status: 200, text: #"{"choices":[{}]}"#)
    }
}

private struct Throws: Transport {
    let error: any Error
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse { throw error }
}

private struct Status: Transport {
    let status: Int
    let log: Locked<[String]>
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        log.with { $0.append(url) }
        try await Task.sleep(nanoseconds: 5_000_000)
        return TransportResponse(status: status, text: "{}")
    }
}

final class CancellationTests: XCTestCase {
    func testCancelDoesNotWaitForStubbornTransport() async throws {
        let r = try router(StubbornTransport(seconds: 3))
        let t0 = Date()
        let task = Task { try await r.route(group: "chat", request: hi) }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        let result = await task.result
        XCTAssertLessThan(Date().timeIntervalSince(t0), 0.6)
        guard case .failure(let e) = result, e is CancellationError else { return XCTFail("expected CancellationError, got \(result)") }
        let st = await r.deploymentStates()["a"]
        XCTAssertEqual(st?.recentFailures, 0)
    }

    func testURLErrorCancelledIsNotNetworkError() async throws {
        let r = try router(URLErrorOnCancel())
        let task = Task { try await r.route(group: "chat", request: hi) }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        let result = await task.result
        guard case .failure(let e) = result, e is CancellationError else { return XCTFail("expected CancellationError, got \(result)") }
        let st = await r.deploymentStates()["a"]
        XCTAssertEqual(st?.recentFailures, 0)
    }

    func testURLErrorCancelledWithoutTaskCancelIsNetworkError() async throws {
        let r = try router(Throws(error: URLError(.cancelled)))
        do {
            _ = try await r.route(group: "chat", request: hi)
            XCTFail("expected RouterError")
        } catch let e as RouterError {
            XCTAssertEqual(e.kind, .allFailed)
            XCTAssertEqual(e.attempts.map(\.outcome), [.networkError])
        }
    }

    func testTimeoutDoesNotWaitForStubbornTransport() async throws {
        let r = try router(StubbornTransport(seconds: 3), timeout: 0.2)
        let t0 = Date()
        do {
            _ = try await r.route(group: "chat", request: hi)
            XCTFail("expected RouterError")
        } catch let e as RouterError {
            XCTAssertEqual(e.attempts.map(\.outcome), [.timeout])
            XCTAssertNil(e.attempts.first?.status)
        }
        XCTAssertLessThan(Date().timeIntervalSince(t0), 1.0)
    }

    func testConcurrentFailuresAreAllRecorded() async throws {
        let log = Locked<[String]>([])
        let r = try router(Status(status: 500, log: log))
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<20 { g.addTask { _ = try? await r.route(group: "chat", request: hi) } }
        }
        XCTAssertEqual(log.get.count, 20)
        XCTAssertEqual(log.get.first, "http://t.invalid/p/chat/completions")
        let st = await r.deploymentStates()["a"]
        XCTAssertEqual(st?.recentFailures, 20)
    }

    func testResetStateClearsCooldown() async throws {
        let log = Locked<[String]>([])
        let r = try Router(
            configJSON: oneDeployment.replacingOccurrences(of: "100", with: "1").replacingOccurrences(of: "TIMEOUT", with: "5"),
            keys: ["p": "k"], options: RouterOptions(transport: Status(status: 429, log: log), rng: { 0 }, now: { 5 }))
        _ = try? await r.route(group: "chat", request: hi)
        var st = await r.deploymentStates()["a"]
        XCTAssertEqual(st?.coolingDown, true)
        await r.resetState()
        st = await r.deploymentStates()["a"]
        XCTAssertEqual(st?.coolingDown, false)
    }
}

// MARK: - 응답 본문 경계 (깊은 중첩, BOM)

private struct Fixed: Transport {
    let text: String
    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        TransportResponse(status: 200, text: text)
    }
}

private func nested(_ depth: Int) -> String {
    // 최상위 객체 1단 + "x" 배열 (depth - 1)단
    #"{"choices":[1],"x":"# + String(repeating: "[", count: depth - 1) + String(repeating: "]", count: depth - 1) + "}"
}

final class ResponseBodyTests: XCTestCase {
    /// 코루틴 스레드(작은 스택)에서 라우터를 거쳐도 깊은 본문이 크래시 없이 분류된다.
    func testDeepNestingThroughRouterDoesNotCrash() async throws {
        let max = JSONValue.maxParseDepth
        // 객체·배열 번갈아 1 + 510 단
        let mixed = #"{"choices":[1],"x":"# + String(repeating: #"{"a":["#, count: 255) + String(repeating: "]}", count: 255) + "}"
        for (depth, text) in [(300, nested(300)), (max, nested(max)), (max - 1, mixed)] {
            let r = try router(Fixed(text: text))
            let res = try await r.route(group: "chat", request: hi)
            XCTAssertEqual(res.attempts.map(\.outcome), [.ok], "depth \(depth)")
            // 값의 비교·직렬화·해제도 같은 스레드에서 버틴다
            XCTAssertEqual(try JSONValue.parse(JSONValue.object(res.response).serialized()), .object(res.response))
        }
        let r = try router(Fixed(text: nested(max + 1)))
        do {
            _ = try await r.route(group: "chat", request: hi)
            XCTFail("expected RouterError")
        } catch let e as RouterError {
            XCTAssertEqual(e.attempts.map(\.outcome), [.badBody])
        }
    }

    func testIterativeParserStructure() throws {
        let v = try JSONValue.parse(#" { "a" : [ [ ] , { } , [1, {"b":[null]}] ] , "a2":{"c":{"d":"e"}} } "#)
        XCTAssertEqual(v, ["a": [[], [:], [1, ["b": [nil]]]], "a2": ["c": ["d": "e"]]])
        XCTAssertEqual(try JSONValue.parse(#"{"k":1,"k":2}"#), ["k": 2])  // JS 처럼 마지막 값
        for bad in ["[1 2]", "{\"a\" 1}", "{\"a\":1 \"b\":2}", "[}", "{]", "[[]", "{\"a\":}", "{,}", "[,1]"] {
            XCTAssertThrowsError(try JSONValue.parse(bad), bad)
        }
    }

    func testDecodeBodyStripsUTF8BOM() {
        let bom = Data([0xEF, 0xBB, 0xBF]) + Data(#"{"choices":[{}]}"#.utf8)
        let text = decodeBody(bom)
        XCTAssertEqual(text.unicodeScalars.first, "{")
        XCTAssertEqual(classifyResponse(status: 200, text: text).0, .ok)
        XCTAssertEqual(decodeBody(Data("é".utf8)), "é")
        XCTAssertEqual(decodeBody(Data()), "")
        // BOM 을 떼는 건 transport 에서 한 번뿐. JSON 파서 자체는 JS JSON.parse 처럼 U+FEFF 를 거부한다
        XCTAssertEqual(classifyResponse(status: 200, text: "\u{FEFF}{\"choices\":[{}]}").0, .badBody)
    }
}


// MARK: - 적합성 러너 자체

final class RunnerDeadlineTests: XCTestCase {
    func testDeadlineFailsInsteadOfHanging() async {
        let t0 = Date()
        // 취소도 무시하고 돌기만 하는 work (라우팅 무한 루프 흉내)
        let stop = Locked(false)
        let r = await Conformance.withDeadline(seconds: 0.2) {
            while !stop.get { usleep(1_000) }
            return []
        }
        stop.with { $0 = true }
        XCTAssertLessThan(Date().timeIntervalSince(t0), 2)
        XCTAssertEqual(r.count, 1)
        XCTAssertTrue(r.first?.hasPrefix("case timeout") ?? false, "\(r)")
    }

    func testDeadlinePassesResultThrough() async {
        let r = await Conformance.withDeadline(seconds: 5) { ["x"] }
        XCTAssertEqual(r, ["x"])
    }
}
