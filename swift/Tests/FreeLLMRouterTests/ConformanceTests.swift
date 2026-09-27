import XCTest
@testable import FreeLLMRouter

/// SPEC 8.1 (메모리 transport) · 8.2 (모의 서버 + 실제 URLSessionTransport) 적합성.
/// FLR_CASE=<이름> 으로 한 케이스만, FLR_SLOW=1 로 slow 케이스(http)까지 돌린다.
final class ConformanceTests: XCTestCase {
    func testMemoryTransport() async throws {
        let suite = try Conformance.loadSuite()
        let results = await Conformance.runAll(suite: suite, mode: "memory") { MemoryHarness(responses: $0["responses"] ?? [:]) }
        report("memory", results)
    }

    func testMockServerHTTP() async throws {
        let suite = try Conformance.loadSuite()
        let server: MockServer
        do {
            server = try MockServer.start()
        } catch {
            print("\n!!!!!!!! SKIP http conformance: 모의 서버를 띄울 수 없다 — \(error) !!!!!!!!\n")
            throw XCTSkip("mock server unavailable: \(error)")
        }
        defer { server.stop() }
        print("mock server: \(server.url)")
        let harness = HTTPHarness(server: server)
        let results = await Conformance.runAll(suite: suite, mode: "http") { _ in harness }
        report("http", results)
    }

    func testConfigCases() throws {
        let suite = try Conformance.loadSuite()
        XCTAssertFalse(suite.configCases.isEmpty)
        var passed = 0
        var lines: [String] = []
        for c in suite.configCases {
            let name = c["name"]?.stringValue ?? "?"
            let f = Conformance.runConfigCase(c)
            if f.isEmpty { passed += 1 } else { XCTFail("\(name): \(f.joined(separator: "; "))") }
            lines.append("\(name.padding(toLength: 40, withPad: " ", startingAt: 0)) | \(f.isEmpty ? "PASS" : "FAIL " + f.joined(separator: "; "))")
        }
        print("\n" + lines.joined(separator: "\n") + "\nconfig \(passed)/\(suite.configCases.count) passed")
    }

    func testModelsJsonParses() throws {
        let config = try parseConfig(try Spec.text("models.json"))
        XCTAssertNotNil(config.groups["chat"])
        XCTAssertNotNil(config.groups["fast"])
    }

    private func report(_ mode: String, _ results: [(String, Conformance.CellResult)]) {
        print(Conformance.table(mode: mode, results))
        XCTAssertFalse(results.isEmpty, "no cases ran")
        for (name, r) in results {
            if case .fail(_, let f) = r { XCTFail("[\(mode)] \(name):\n  " + f.joined(separator: "\n  ")) }
        }
    }
}
