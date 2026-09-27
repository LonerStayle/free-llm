import Foundation
@testable import FreeLLMRouter

struct LoggedRequest: Sendable {
    let path: String
    let headers: [String: String]  // 이름 소문자
    let body: JSONValue
}

/// 적합성 러너가 케이스를 돌리는 환경: 메모리 가짜 transport 또는 모의 서버 + 실제 URLSession.
protocol Harness: Sendable {
    var name: String { get }
    var base: String { get }
    /// nil 이면 라우터 기본 transport (URLSessionTransport)
    var transport: (any Transport)? { get }
    func load(_ responses: JSONValue) async throws
    func fetchLog() async throws -> [LoggedRequest]
}

// MARK: - 메모리 (SPEC 8.1) — spec/mock-server/server.mjs 의 ScriptBook·materialize 를 옮김

struct Materialized: Sendable {
    let status: Int
    let text: String
    let delayMs: Double
    let bodyDelayMs: Double
    let close: Bool
}

func defaultCompletion(model: String, seq: Int) -> JSONValue {
    [
        "id": .string("mock-\(seq)"), "object": "chat.completion", "created": 0, "model": .string(model),
        "choices": [["index": 0, "message": ["role": "assistant", "content": .string("ok:\(model)")], "finish_reason": "stop"]],
        "usage": ["prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2],
    ]
}

func materialize(_ e: JSONValue, model: String, seq: Int) -> Materialized {
    let status = Int(e["status"]?.doubleValue ?? 200)
    let text: String
    switch e["body"] {
    case nil:
        text = (200...299).contains(status)
            ? defaultCompletion(model: model, seq: seq).serialized()
            : JSONValue.object(["error": ["message": .string("mock status \(status)"), "code": .number(Double(status))]]).serialized()
    case .string(let s)?: text = s
    case let v?: text = v.serialized()
    }
    return Materialized(
        status: status, text: text,
        delayMs: e["delayMs"]?.doubleValue ?? 0,
        bodyDelayMs: e["bodyDelayMs"]?.doubleValue ?? 0,
        close: e["action"]?.stringValue == "close"
    )
}

final class ScriptBook: @unchecked Sendable {
    private let lock = NSLock()
    private let responses: JSONObject
    private var used: [String: Int] = [:]
    private var seq = 0
    init(_ responses: JSONValue) { self.responses = responses.objectValue ?? [:] }

    func next(_ model: String) -> Materialized {
        lock.lock()
        defer { lock.unlock() }
        let list = responses[model]?.arrayValue ?? []
        let i = used[model] ?? 0
        used[model] = i + 1
        seq += 1
        return materialize(i < list.count ? list[i] : [:], model: model, seq: seq)
    }
}

struct MemoryTransport: Transport {
    let book: ScriptBook
    let log: Locked<[LoggedRequest]>

    struct ConnectionClosed: Error {}

    func send(url: String, headers: [String: String], body: String) async throws -> TransportResponse {
        let parsed = (try? JSONValue.parse(body)) ?? .string(body)
        let path = URLComponents(string: url)?.path ?? url
        var lower: [String: String] = [:]
        for (k, v) in headers { lower[k.lowercased()] = v }
        log.with { $0.append(LoggedRequest(path: path, headers: lower, body: parsed)) }
        let model: String
        if case .string(let m)? = parsed["model"] { model = m } else { model = "undefined" }
        let r = book.next(model)
        // 실제로 기다린다(취소 가능). 그래야 라우터의 타임아웃·취소 경로가 돈다 (SPEC 8.1)
        if r.delayMs > 0 { try await Task.sleep(nanoseconds: UInt64(r.delayMs * 1_000_000)) }
        if r.close { throw ConnectionClosed() }
        if r.bodyDelayMs > 0 { try await Task.sleep(nanoseconds: UInt64(r.bodyDelayMs * 1_000_000)) }
        return TransportResponse(status: r.status, text: r.text)
    }
}

struct MemoryHarness: Harness {
    let name = "memory"
    let base = "http://mock.invalid"
    let log = Locked<[LoggedRequest]>([])
    let book: ScriptBook
    var transport: (any Transport)? { MemoryTransport(book: book, log: log) }

    init(responses: JSONValue) { book = ScriptBook(responses) }
    func load(_ responses: JSONValue) async throws {}
    func fetchLog() async throws -> [LoggedRequest] { log.get }
}

// MARK: - 모의 서버 HTTP (SPEC 8.2)

final class MockServer: @unchecked Sendable {
    let url: String
    private let process: Process?
    private let stdin: Pipe?

    private init(url: String, process: Process?, stdin: Pipe?) {
        self.url = url
        self.process = process
        self.stdin = stdin
    }

    struct StartError: Error, CustomStringConvertible { let description: String }

    /// FLR_MOCK_URL 이 있으면 그 서버, 없으면 node 로 직접 띄운다(stdin 파이프 → 테스트가 죽어도 서버가 끝난다).
    static func start() throws -> MockServer {
        if let u = Spec.env["FLR_MOCK_URL"], !u.isEmpty {
            return MockServer(url: u.hasSuffix("/") ? String(u.dropLast()) : u, process: nil, stdin: nil)
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [
            Spec.env["FLR_NODE"] ?? "node",
            Spec.dir.appendingPathComponent("mock-server/server.mjs").path,
            "--port", "0", "--exit-on-stdin-close",
        ]
        let inPipe = Pipe()
        let outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.standardError
        try p.run()
        var buf = Data()
        let reader = outPipe.fileHandleForReading
        while !buf.contains(0x0A) {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            buf.append(chunk)
        }
        guard let nl = buf.firstIndex(of: 0x0A),
              let line = String(data: buf[..<nl], encoding: .utf8),
              let u = (try? JSONValue.parse(line))?["url"]?.stringValue
        else {
            p.terminate()
            throw StartError(description: "mock server did not print its url (node 가 PATH 에 있나?)")
        }
        return MockServer(url: u, process: p, stdin: inPipe)
    }

    func stop() {
        guard let process else { return }
        try? stdin?.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
}

struct HTTPHarness: Harness {
    let name = "http"
    let server: MockServer
    var base: String { server.url }
    var transport: (any Transport)? { nil }  // 라우터 기본 URLSessionTransport 를 그대로 검증

    struct HarnessError: Error, CustomStringConvertible { let description: String }

    func load(_ responses: JSONValue) async throws {
        var req = URLRequest(url: URL(string: server.url + "/__scenario")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(JSONValue.object(["responses": responses]).serialized().utf8)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status != 200 {
            throw HarnessError(description: "/__scenario → \(status) \(String(decoding: data, as: UTF8.self))")
        }
    }

    func fetchLog() async throws -> [LoggedRequest] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: server.url + "/__log")!)
        let v = try JSONValue.parse(String(decoding: data, as: UTF8.self))
        return (v["requests"]?.arrayValue ?? []).map { r in
            var h: [String: String] = [:]
            for (k, v) in r["headers"]?.objectValue ?? [:] { h[k.lowercased()] = v.stringValue ?? v.serialized() }
            return LoggedRequest(path: r["path"]?.stringValue ?? "", headers: h, body: r["body"] ?? .null)
        }
    }
}
