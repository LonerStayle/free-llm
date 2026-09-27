import XCTest
import FreeLLMRouter

/// 실제 OpenRouter 스모크 (spec/live-smoke.md). OPENROUTER_API_KEY 환경변수가 없으면 SKIP.
///   OPENROUTER_API_KEY=... swift test --filter LiveSmokeTests
/// 키는 환경변수에서만 읽고, 키·Authorization 은 출력하지 않는다.
final class LiveSmokeTests: XCTestCase {
    func testLiveSmoke() async throws {
        guard let key = ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"], !key.isEmpty else {
            print("LIVE SKIP OPENROUTER_API_KEY not set")
            throw XCTSkip("LIVE SKIP OPENROUTER_API_KEY not set")
        }
        // models.json 에서 settings.timeoutSeconds 만 20 으로 바꾼다
        guard case .object(var root) = try Spec.json("models.json") else { return XCTFail("models.json not an object") }
        var settings = root["settings"]?.objectValue ?? [:]
        settings["timeoutSeconds"] = 20
        root["settings"] = .object(settings)
        let router = Router(config: try parseConfig(JSONValue.object(root).serialized()), keys: ["openrouter": key])
        let request: JSONObject = ["messages": [["role": "user", "content": "Reply with the single word: pong"]], "max_tokens": 256]

        // 두 호출 합쳐 5분 제한. 넘기면 진행 중인 route 를 취소하고 실패
        let work = Task { () -> Bool in
            var ok = true
            for group in ["fast", "chat"] {
                let t0 = Date()
                do {
                    let r = try await router.route(group: group, request: request)
                    let content = String((r.content ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(80))
                    print("LIVE \(group) ok deployment=\(r.deploymentId) served_group=\(r.group) ms=\(ms(t0)) attempts=[\(fmt(r.attempts))] content=\(JSONValue.string(content).serialized())")
                } catch let e as RouterError {
                    ok = false
                    print("LIVE \(group) FAIL kind=\(e.kind.rawValue) status=\(e.status.map(String.init) ?? "null") ms=\(ms(t0)) attempts=[\(fmt(e.attempts))]")
                } catch is CancellationError {
                    print("LIVE TIMEOUT total>300s (group \(group))")
                    return false
                } catch {
                    ok = false
                    print("LIVE \(group) FAIL \(error)")
                }
            }
            return ok
        }
        let limit = Task {
            try await Task.sleep(nanoseconds: 300 * 1_000_000_000)
            work.cancel()
        }
        let ok = await work.value
        limit.cancel()
        XCTAssertTrue(ok, "live smoke failed (see LIVE lines)")
    }
}

private func ms(_ t0: Date) -> Int { Int(Date().timeIntervalSince(t0) * 1000) }

private func fmt(_ attempts: [Attempt]) -> String {
    attempts.map { "\($0.deploymentId):\($0.outcome.rawValue)\($0.status.map { ":\($0)" } ?? ""):\($0.durationMs)ms" }
        .joined(separator: ",")
}
