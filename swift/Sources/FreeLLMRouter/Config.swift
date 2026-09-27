import Foundation

/// 설정이 잘못됐을 때 `parseConfig` 가 던진다 (SPEC 6절). 라우팅 에러가 아니다.
public struct ConfigError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { "ConfigError: \(message)" }
}

public struct Provider: Sendable, Equatable {
    public let id: String
    public let baseUrl: String
    public let keyName: String?
    public let extraHeaders: [String: String]
}

public struct Deployment: Sendable, Equatable {
    public let id: String
    public let provider: String
    public let model: String
    public let rpm: Int
    public let maxInputTokens: Int?
    public let enabled: Bool
}

public struct Settings: Sendable, Equatable {
    public let numRetries: Int
    public let allowedFails: Int
    public let cooldownSeconds: Double
    public let timeoutSeconds: Double
    public let fallbacks: [String: [String]]
    public let contextWindowFallbacks: [String: [String]]

    /// round(cooldownSeconds × 1000). 실패 창과 쿨다운 길이 (3.4)
    public var cooldownMs: Int64 { Settings.toMs(cooldownSeconds) }
    /// round(timeoutSeconds × 1000). 시도 한 번의 제한 (3.6)
    public var timeoutMs: Int64 { Settings.toMs(timeoutSeconds) }

    // 양수라 .5 는 올림(JS Math.round 와 같다). 터무니없이 큰 값은 오버플로 대신 상한으로 자른다.
    static func toMs(_ seconds: Double) -> Int64 {
        let ms = (seconds * 1000).rounded(.toNearestOrAwayFromZero)
        return ms >= 1e15 ? 1_000_000_000_000_000 : Int64(ms)
    }
}

/// `models.json` 형식을 검증·정규화한 설정.
public struct Config: Sendable, Equatable {
    public let providers: [Provider]
    /// 그룹 이름 → 배포 목록 (설정 순서 유지)
    public let groups: [String: [Deployment]]
    public let settings: Settings

    public func provider(_ id: String) -> Provider? { providers.first { $0.id == id } }

    /// `parseConfig(_:)` 와 같다.
    public static func parse(_ json: String) throws -> Config { try parseConfig(json) }
}

private let intMax = 2_147_483_647.0

/// models.json 형식 문자열 → Config. 잘못되면 `ConfigError` (SPEC 6절).
/// 모르는 키는 모든 레벨에서 무시하고, 선택 필드의 null 은 없는 것으로 본다.
public func parseConfig(_ json: String) throws -> Config {
    let raw: JSONValue
    do {
        raw = try JSONValue.parse(json)
    } catch {
        throw ConfigError("invalid JSON: \(error)")
    }
    return try normalizeConfig(raw)
}

/// 이미 파싱한 JSON 값에서 Config 를 만든다.
public func normalizeConfig(_ raw: JSONValue) throws -> Config {
    guard case .object(let root) = raw else { throw ConfigError("config must be an object") }
    if let v = present(root["version"]), v != .number(1) { throw ConfigError("unsupported version: \(v.serialized())") }

    guard case .array(let rawProviders)? = root["providers"] else { throw ConfigError("providers must be an array") }
    var providers: [Provider] = []
    var providerIds = Set<String>()
    for rp in rawProviders {
        guard case .object(let p) = rp else { throw ConfigError("provider must be an object") }
        guard let id = nonEmptyString(p["id"]) else { throw ConfigError("provider.id required") }
        if providerIds.contains(id) { throw ConfigError("duplicate provider id: \(id)") }
        guard let baseUrl = nonEmptyString(p["baseUrl"]) else { throw ConfigError("provider \(id): baseUrl required") }
        var keyName: String?
        if let k = present(p["keyName"]) {
            guard case .string(let s) = k else { throw ConfigError("provider \(id): keyName must be a string") }
            keyName = s
        }
        var extra: [String: String] = [:]
        if let e = present(p["extraHeaders"]) {
            guard case .object(let eo) = e else { throw ConfigError("provider \(id): extraHeaders must be an object") }
            for (h, v) in eo {
                let lower = asciiLower(h)
                if lower == "authorization" || lower == "content-type" {
                    throw ConfigError("provider \(id): extraHeaders must not set \(h)")
                }
                guard case .string(let s) = v else { throw ConfigError("provider \(id): extraHeaders.\(h) must be a string") }
                extra[h] = s
            }
        }
        providerIds.insert(id)
        providers.append(Provider(id: id, baseUrl: baseUrl, keyName: keyName, extraHeaders: extra))
    }

    guard case .object(let rawGroups)? = root["groups"] else { throw ConfigError("groups must be an object") }
    var groups: [String: [Deployment]] = [:]
    var seen = Set<String>()
    // 오류 메시지가 실행마다 같도록 이름순으로 검사한다(결과는 순서와 무관).
    for name in rawGroups.keys.sorted() {
        guard case .object(let g) = rawGroups[name]!, case .array(let rawDeps)? = g["deployments"] else {
            throw ConfigError("group \(name): deployments must be an array")
        }
        var deps: [Deployment] = []
        for rd in rawDeps {
            guard case .object(let d) = rd else { throw ConfigError("group \(name): deployment must be an object") }
            guard let id = nonEmptyString(d["id"]) else { throw ConfigError("group \(name): deployment.id required") }
            if seen.contains(id) { throw ConfigError("duplicate deployment id: \(id)") }
            seen.insert(id)
            guard case .string(let provider)? = d["provider"], providerIds.contains(provider) else {
                throw ConfigError("deployment \(id): unknown provider \(d["provider"]?.serialized() ?? "undefined")")
            }
            guard let model = nonEmptyString(d["model"]) else { throw ConfigError("deployment \(id): model required") }
            guard let rpm = integer(d["rpm"], min: 1) else {
                throw ConfigError("deployment \(id): rpm must be an integer in [1, 2147483647]")
            }
            var maxInputTokens: Int?
            if let m = present(d["maxInputTokens"]) {
                guard let v = integer(m, min: 1) else {
                    throw ConfigError("deployment \(id): maxInputTokens must be an integer in [1, 2147483647]")
                }
                maxInputTokens = v
            }
            var enabled = true
            if let e = present(d["enabled"]) {
                guard case .bool(let b) = e else { throw ConfigError("deployment \(id): enabled must be a boolean") }
                enabled = b
            }
            deps.append(Deployment(id: id, provider: provider, model: model, rpm: rpm,
                                   maxInputTokens: maxInputTokens, enabled: enabled))
        }
        groups[name] = deps
    }

    var rs: JSONObject = [:]
    if let s = present(root["settings"]) {
        guard case .object(let o) = s else { throw ConfigError("settings must be an object") }
        rs = o
    }
    var numRetries = 3
    if let v = present(rs["numRetries"]) {
        guard let n = integer(v, min: 0) else { throw ConfigError("settings.numRetries must be an integer >= 0") }
        numRetries = n
    }
    var allowedFails = 3
    if let v = present(rs["allowedFails"]) {
        guard let n = integer(v, min: 1) else { throw ConfigError("settings.allowedFails must be an integer >= 1") }
        allowedFails = n
    }
    func positive(_ key: String, _ dflt: Double) throws -> Double {
        guard let v = present(rs[key]) else { return dflt }
        guard case .number(let n) = v, n.isFinite, n > 0 else { throw ConfigError("settings.\(key) must be a number > 0") }
        return n
    }
    let cooldownSeconds = try positive("cooldownSeconds", 60)
    let timeoutSeconds = try positive("timeoutSeconds", 60)
    func fallbackMap(_ key: String) throws -> [String: [String]] {
        guard let v = present(rs[key]) else { return [:] }
        guard case .object(let o) = v else { throw ConfigError("settings.\(key) must be an object") }
        var out: [String: [String]] = [:]
        for from in o.keys.sorted() {
            if groups[from] == nil { throw ConfigError("settings.\(key): unknown group \(from)") }
            guard case .array(let list) = o[from]! else { throw ConfigError("settings.\(key).\(from) must be an array") }
            out[from] = try list.map { to in
                guard case .string(let s) = to, groups[s] != nil else {
                    throw ConfigError("settings.\(key).\(from): unknown group \(to.serialized())")
                }
                return s
            }
        }
        return out
    }
    let settings = Settings(
        numRetries: numRetries,
        allowedFails: allowedFails,
        cooldownSeconds: cooldownSeconds,
        timeoutSeconds: timeoutSeconds,
        fallbacks: try fallbackMap("fallbacks"),
        contextWindowFallbacks: try fallbackMap("contextWindowFallbacks")
    )
    return Config(providers: providers, groups: groups, settings: settings)
}

// null 은 없는 것으로 본다.
private func present(_ v: JSONValue?) -> JSONValue? {
    guard let v, v != .null else { return nil }
    return v
}

private func nonEmptyString(_ v: JSONValue?) -> String? {
    guard case .string(let s)? = v, !s.isEmpty else { return nil }
    return s
}

// 정수 = 소수부가 0 인 JSON 수 (4 와 4.0 모두 4). 범위 [min, 2147483647].
private func integer(_ v: JSONValue?, min: Int) -> Int? {
    guard case .number(let n)? = v, n.isFinite, n == n.rounded(.towardZero), n >= Double(min), n <= intMax else { return nil }
    return Int(n)
}
