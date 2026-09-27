import Foundation
@testable import FreeLLMRouter

/// spec/test-cases.json 적합성 러너 (SPEC 8.1·8.2). 참조 러너(run-conformance.mjs)와 같은 검사를 한다.
enum Conformance {
    struct Suite {
        let clockStartMs: Int64
        let placeholder: String
        let cases: [JSONValue]
        let configCases: [JSONValue]
    }

    static func loadSuite() throws -> Suite {
        let s = try Spec.json("test-cases.json")
        return Suite(
            clockStartMs: Int64(s["clockStartMs"]?.doubleValue ?? 1_000_000),
            placeholder: s["mockBasePlaceholder"]?.stringValue ?? "{{MOCK_BASE}}",
            cases: s["cases"]?.arrayValue ?? [],
            configCases: s["configCases"]?.arrayValue ?? []
        )
    }

    static func isSlow(_ c: JSONValue) -> Bool {
        (c["tags"]?.arrayValue ?? []).contains(.string("slow"))
    }

    enum CellResult {
        case pass(ms: Int)
        case fail(ms: Int, failures: [String])
        case skip(String)
    }

    /// 케이스 전부를 순서대로 돌리고 (이름, 결과) 목록을 준다. FLR_CASE 로 하나만 고를 수 있다.
    static func runAll(
        suite: Suite, mode: String, harnessFor: (JSONValue) -> any Harness
    ) async -> [(String, CellResult)] {
        let only = Spec.env["FLR_CASE"].flatMap { $0.isEmpty ? nil : $0 }
        let slowOn = Spec.env["FLR_SLOW"] == "1" || only != nil
        var out: [(String, CellResult)] = []
        for c in suite.cases {
            let name = c["name"]?.stringValue ?? "?"
            if let only, only != name { continue }
            if isSlow(c) {
                if mode == "memory" { out.append((name, .skip("slow: http only"))); continue }
                if !slowOn { out.append((name, .skip("slow: FLR_SLOW=1"))); continue }
            }
            let t0 = Date()
            let harness = harnessFor(c)
            let limit = isSlow(c) ? slowCaseTimeoutSeconds : caseTimeoutSeconds
            let failures = await withDeadline(seconds: limit) {
                do {
                    return try await runCase(c, suite: suite, harness: harness)
                } catch {
                    return ["harness error: \(error)"]
                }
            }
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            out.append((name, failures.isEmpty ? .pass(ms: ms) : .fail(ms: ms, failures: failures)))
        }
        return out
    }

    // MARK: 케이스별 시간 제한 (라우팅이 무한 루프에 빠지는 회귀가 테스트를 매달지 않게)

    static let caseTimeoutSeconds = 30.0
    static let slowCaseTimeoutSeconds = 40.0

    /// work 와 타이머 중 먼저 끝나는 쪽을 돌려준다. 시간을 넘기면 work Task 를 취소하고 FAIL 을 준다.
    /// 구조적 동시성(TaskGroup)은 취소를 무시하는 work 를 끝까지 기다리므로 쓰지 않는다.
    static func withDeadline(
        seconds: Double, _ work: @escaping @Sendable () async -> [String]
    ) async -> [String] {
        let gate = Locked<(cont: CheckedContinuation<[String], Never>?, tasks: [Task<Void, Never>], done: Bool)>(
            (nil, [], false))
        @Sendable func finish(_ r: [String]) {
            let (c, ts): (CheckedContinuation<[String], Never>?, [Task<Void, Never>]) = gate.with { g in
                guard !g.done else { return (nil, []) }
                g.done = true
                defer { g.cont = nil; g.tasks = [] }
                return (g.cont, g.tasks)
            }
            for t in ts { t.cancel() }
            c?.resume(returning: r)
        }
        return await withCheckedContinuation { (cont: CheckedContinuation<[String], Never>) in
            gate.with { $0.cont = cont }
            let tasks = [
                Task { finish(await work()) },
                Task {
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
                    finish(["case timeout: \(Int(seconds))s 안에 끝나지 않음 (무한 루프·멈춤 의심)"])
                },
            ]
            let late = gate.with { g -> Bool in
                if g.done { return true }
                g.tasks = tasks
                return false
            }
            if late { for t in tasks { t.cancel() } }
        }
    }

    static func table(mode: String, _ results: [(String, CellResult)]) -> String {
        let w = max(4, results.map { $0.0.count }.max() ?? 4)
        var lines = ["", "\("case".padding(toLength: w, withPad: " ", startingAt: 0)) | \(mode)",
                     String(repeating: "-", count: w) + "-|-" + String(repeating: "-", count: 16)]
        var passed = 0, ran = 0, skipped = 0
        for (name, r) in results {
            let cell: String
            switch r {
            case .pass(let ms): cell = "PASS \(String(repeating: " ", count: max(0, 5 - String(ms).count)))\(ms)ms"; passed += 1; ran += 1
            case .fail(let ms, _): cell = "FAIL \(ms)ms"; ran += 1
            case .skip(let why): cell = "SKIP \(why)"; skipped += 1
            }
            lines.append("\(name.padding(toLength: w, withPad: " ", startingAt: 0)) | \(cell)")
        }
        for (name, r) in results {
            if case .fail(_, let f) = r {
                lines.append("\n✗ \(name) [\(mode)]")
                lines += f.map { "    - \($0)" }
            }
        }
        lines.append("\n\(passed)/\(ran) passed (\(results.count) cases × \(mode); \(skipped) skipped)")
        return lines.joined(separator: "\n")
    }

    // MARK: 케이스 한 개

    static func substitute(_ v: JSONValue, _ ph: String, _ base: String) -> JSONValue {
        switch v {
        case .string(let s): return .string(s.replacingOccurrences(of: ph, with: base))
        case .array(let a): return .array(a.map { substitute($0, ph, base) })
        case .object(let o): return .object(o.mapValues { substitute($0, ph, base) })
        default: return v
        }
    }

    static func show(_ v: JSONValue?) -> String { v?.serialized() ?? "undefined" }

    static func runCase(_ c: JSONValue, suite: Suite, harness: any Harness) async throws -> [String] {
        var failures: [String] = []
        func fail(_ m: String) { failures.append(m) }

        let configJSON = substitute(c["config"] ?? .null, suite.placeholder, harness.base)
        let config: Config
        do {
            config = try parseConfig(configJSON.serialized())
        } catch {
            return ["parseConfig: \(error)"]
        }

        let clock = Locked(suite.clockStartMs)
        let rngValues = (c["rng"]?.arrayValue ?? []).map { $0.doubleValue ?? 0 }
        let rngState = Locked((index: 0, exhausted: false))
        let rng: @Sendable () -> Double = {
            rngState.with { s in
                if s.index >= rngValues.count { s.exhausted = true; return 0 }
                defer { s.index += 1 }
                return rngValues[s.index]
            }
        }
        try await harness.load(c["responses"] ?? [:])

        var keys: [String: String] = [:]
        for (k, v) in c["keys"]?.objectValue ?? [:] { if let s = v.stringValue { keys[k] = s } }
        let router = Router(config: config, keys: keys,
                            options: RouterOptions(transport: harness.transport, rng: rng, now: { clock.get }))
        var seen = 0

        for (i, step) in (c["steps"]?.arrayValue ?? []).enumerated() {
            let op = step["op"]?.stringValue ?? "?"
            let whereStr = "step \(i) (\(op))"
            switch op {
            case "advance":
                let ms = Int64(step["ms"]?.doubleValue ?? 0)
                clock.with { $0 += ms }
                continue
            case "reset":
                await router.resetState()
                continue
            case "expectState":
                let states = await router.deploymentStates()
                for (id, want) in step["states"]?.objectValue ?? [:] {
                    guard let got = states[id] else { fail("\(whereStr) unknown deployment \(id)"); continue }
                    let gotJSON: JSONObject = [
                        "coolingDown": .bool(got.coolingDown),
                        "cooldownUntilMs": got.cooldownUntilMs.map { .number(Double($0)) } ?? .null,
                        "recentFailures": .number(Double(got.recentFailures)),
                    ]
                    for (k, v) in want.objectValue ?? [:] where gotJSON[k] != v {
                        fail("\(whereStr) \(id).\(k) expected \(show(v)), actual \(show(gotJSON[k]))")
                    }
                }
                continue
            case "request":
                break
            default:
                fail("\(whereStr) unknown op")
                continue
            }

            let group = step["group"]?.stringValue ?? ""
            let request = step["request"]?.objectValue ?? [:]
            let e = step["expect"] ?? [:]

            if let cancelAfter = step["cancelAfterMs"]?.doubleValue {
                try await runCancelStep(router: router, group: group, request: request, cancelAfterMs: cancelAfter,
                                        expect: e, harness: harness, whereStr: whereStr, seen: &seen, fail: fail)
                continue
            }

            var result: RouteResult?
            var error: RouterError?
            do {
                result = try await router.route(group: group, request: request)
            } catch let x as RouterError {
                error = x
            } catch {
                fail("\(whereStr) unexpected exception: \(error)")
                return failures
            }
            let attempts = result?.attempts ?? error?.attempts ?? []

            if e["ok"] == .bool(true) {
                if let r = result {
                    if .string(r.deploymentId) != e["deployment"] { fail("\(whereStr) deployment \(r.deploymentId) != \(show(e["deployment"]))") }
                    if .string(r.group) != e["group"] { fail("\(whereStr) group \(r.group) != \(show(e["group"]))") }
                    if let want = e["content"] {
                        let got = r.response["choices"]?[0]?["message"]?["content"]
                        if got != want { fail("\(whereStr) content \(show(got)) != \(show(want))") }
                    }
                } else if let error {
                    fail("\(whereStr) expected success, got error \(error.kind.rawValue) (\(error.message))")
                }
            } else if let r = result {
                fail("\(whereStr) expected error \(show(e["error"]?["kind"])), got success via \(r.deploymentId)")
            } else if let error {
                let we = e["error"] ?? [:]
                if .string(error.kind.rawValue) != we["kind"] { fail("\(whereStr) error.kind \(error.kind.rawValue) != \(show(we["kind"]))") }
                let gotStatus: JSONValue = error.status.map { .number(Double($0)) } ?? .null
                if gotStatus != (we["status"] ?? .null) { fail("\(whereStr) error.status \(show(gotStatus)) != \(show(we["status"]))") }
                if let bc = we["bodyContains"]?.stringValue, !(error.body?.contains(bc) ?? false) {
                    fail("\(whereStr) error.body \(error.body ?? "nil") does not contain \(bc)")
                }
                if we["kind"] != "non_retryable", error.body != nil { fail("\(whereStr) error.body should be null for \(error.kind.rawValue)") }
            }

            let gotAttempts: JSONValue = .array(attempts.map {
                ["deployment": .string($0.deploymentId), "group": .string($0.group), "outcome": .string($0.outcome.rawValue),
                 "status": $0.status.map { .number(Double($0)) } ?? .null]
            })
            if gotAttempts != (e["attempts"] ?? []) {
                fail("\(whereStr) attempts\n      expected \(show(e["attempts"]))\n      actual   \(gotAttempts.serialized())")
            }

            let log = try await harness.fetchLog()
            let received = Array(log.dropFirst(seen))
            seen = log.count
            checkRequests(whereStr, received, attempts, e, config, fail)
        }

        let rs = rngState.get
        if rs.exhausted { fail("rng exhausted after \(rngValues.count) values") }
        if rs.index != rngValues.count && !rs.exhausted { fail("rng used \(rs.index) of \(rngValues.count) values") }
        return failures
    }

    static func checkRequests(
        _ whereStr: String, _ received: [LoggedRequest], _ attempts: [Attempt], _ e: JSONValue,
        _ config: Config, _ fail: (String) -> Void
    ) {
        // 불변식: 시도마다 정확히 한 요청, 경로와 body.model 이 그 배포의 것
        guard received.count == attempts.count else {
            fail("\(whereStr) provider received \(received.count) requests, attempts \(attempts.count)")
            return
        }
        let deps = config.groups.values.flatMap { $0 }
        for (i, a) in attempts.enumerated() {
            guard let d = deps.first(where: { $0.id == a.deploymentId }), let p = config.provider(d.provider) else { continue }
            var base = p.baseUrl
            while base.hasSuffix("/") { base.removeLast() }
            let wantPath = URLComponents(string: base + "/chat/completions")?.path ?? ""
            if received[i].path != wantPath { fail("\(whereStr) request[\(i)] path \(received[i].path) != \(wantPath)") }
            if received[i].body["model"] != .string(d.model) {
                fail("\(whereStr) request[\(i)] body.model \(show(received[i].body["model"])) != \(d.model)")
            }
        }
        guard let wantReqs = e["requests"]?.arrayValue else { return }
        guard wantReqs.count == received.count else {
            fail("\(whereStr) expected \(wantReqs.count) requests, got \(received.count)")
            return
        }
        for (i, er) in wantReqs.enumerated() {
            let r = received[i]
            if let p = er["path"]?.stringValue, p != r.path { fail("\(whereStr) request[\(i)] path \(r.path) != \(p)") }
            for (k, v) in er["headers"]?.objectValue ?? [:] {
                let got = r.headers[k.lowercased()]
                if got != v.stringValue { fail("\(whereStr) request[\(i)] header \(k): \(got ?? "nil") != \(show(v))") }
            }
            for k in er["absentHeaders"]?.arrayValue ?? [] {
                if let name = k.stringValue, r.headers[name.lowercased()] != nil {
                    fail("\(whereStr) request[\(i)] header \(name) should be absent")
                }
            }
            if let body = er["body"], body != r.body {
                fail("\(whereStr) request[\(i)] body\n      expected \(body.serialized())\n      actual   \(r.body.serialized())")
            }
        }
    }

    // 취소 단계: cancelAfterMs == 0 이면 이미 취소된 Task 안에서 호출, 아니면 그 ms 뒤 Task 취소.
    static func runCancelStep(
        router: Router, group: String, request: JSONObject, cancelAfterMs: Double, expect: JSONValue,
        harness: any Harness, whereStr: String, seen: inout Int, fail: (String) -> Void
    ) async throws {
        let t0 = Date()
        let task: Task<RouteResult, Error>
        if cancelAfterMs == 0 {
            task = Task {
                withUnsafeCurrentTask { $0?.cancel() }
                return try await router.route(group: group, request: request)
            }
        } else {
            task = Task { try await router.route(group: group, request: request) }
            try await Task.sleep(nanoseconds: UInt64(cancelAfterMs * 1_000_000))
            task.cancel()
        }
        switch await task.result {
        case .success(let r):
            fail("\(whereStr) expected cancellation, got success via \(r.deploymentId)")
        case .failure(let x as RouterError):
            fail("\(whereStr) expected cancellation, got RouterError \(x.kind.rawValue)")
        case .failure(let x) where !(x is CancellationError):
            fail("\(whereStr) expected CancellationError, got \(type(of: x)): \(x)")
        case .failure:
            break
        }
        let elapsed = Date().timeIntervalSince(t0) * 1000
        if elapsed > cancelAfterMs + 500 { fail("\(whereStr) cancellation took \(Int(elapsed))ms") }
        let log = try await harness.fetchLog()
        let received = Array(log.dropFirst(seen))
        seen = log.count
        let want = expect["requests"]?.arrayValue ?? []
        if received.count != want.count { fail("\(whereStr) provider received \(received.count) requests, expected \(want.count)") }
        for (i, er) in want.enumerated() {
            if let p = er["path"]?.stringValue, i < received.count, received[i].path != p {
                fail("\(whereStr) request[\(i)] path \(received[i].path) != \(p)")
            }
        }
    }

    // MARK: configCases

    static func runConfigCase(_ c: JSONValue) -> [String] {
        let want = c["expect"]?.stringValue ?? "?"
        var got: String
        var detail = ""
        do {
            _ = try parseConfig(c["json"]?.stringValue ?? "")
            got = "ok"
        } catch let e as ConfigError {
            got = "config_error"
            detail = " (\(e.message))"
        } catch {
            return ["unexpected exception: \(error)"]
        }
        return got == want ? [] : ["expected \(want), got \(got)\(detail)"]
    }
}
