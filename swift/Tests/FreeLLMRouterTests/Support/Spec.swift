import Foundation
@testable import FreeLLMRouter

/// spec/ 위치: FLR_SPEC_DIR, 없으면 저장소 상대 경로 (swift/../spec). 파일은 복사하지 않는다 (SPEC 8.1).
enum Spec {
    static let dir: URL = {
        if let d = ProcessInfo.processInfo.environment["FLR_SPEC_DIR"], !d.isEmpty {
            return URL(fileURLWithPath: d, isDirectory: true).standardizedFileURL
        }
        // .../swift/Tests/FreeLLMRouterTests/Support/Spec.swift → .../swift
        let pkg = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return pkg.appendingPathComponent("../spec", isDirectory: true).standardizedFileURL
    }()

    static func text(_ name: String) throws -> String {
        try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
    }

    static func json(_ name: String) throws -> JSONValue {
        try JSONValue.parse(try text(name))
    }

    static let env = ProcessInfo.processInfo.environment
}

/// 여러 Task 에서 읽고 쓰는 값 (테스트용).
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    func with<R>(_ f: (inout T) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return f(&value)
    }
    var get: T { with { $0 } }
}
