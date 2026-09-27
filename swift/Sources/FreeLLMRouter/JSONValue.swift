import Foundation

public typealias JSONObject = [String: JSONValue]

/// 요청·응답·설정에 쓰는 JSON 값. 수는 Double 로 담는다(JS 와 같은 범위).
public enum JSONValue: Sendable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)

    public var objectValue: JSONObject? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var isNull: Bool { self == .null }

    public subscript(key: String) -> JSONValue? { objectValue?[key] }
    public subscript(index: Int) -> JSONValue? {
        guard let a = arrayValue, index >= 0, index < a.count else { return nil }
        return a[index]
    }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var o = JSONObject()
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
}

// MARK: - 파싱 (RFC 8259, 엄격)

public struct JSONParseError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public let offset: Int
    public var description: String { "\(message) at byte \(offset)" }
}

extension JSONValue {
    /// JSON 문서 하나를 파싱한다. 앞뒤 공백 외의 여분이 있으면 오류.
    /// 재귀 없이 명시적 스택으로 파싱하므로 async 코루틴의 작은 스택에서도 깊은 중첩에 안전하다.
    /// 중첩이 `maxParseDepth` 를 넘으면 오류(응답이면 bad_body).
    public static func parse(_ text: String) throws -> JSONValue {
        var p = JSONParser(bytes: Array(text.utf8))
        p.skipWS()
        let v = try p.document()
        p.skipWS()
        guard p.i == p.bytes.count else { throw p.error("unexpected trailing data") }
        return v
    }

    /// 파싱이 허용하는 최대 중첩 깊이.
    public static let maxParseDepth = JSONParser.maxDepth
}

struct JSONParser {
    let bytes: [UInt8]
    var i = 0
    /// 파싱은 반복식이라 스택을 쓰지 않지만, 결과 값의 해제·비교·직렬화는 재귀라 여기서 자른다.
    /// Debug 빌드의 async 스레드에서 512단의 파싱·직렬화·비교·해제가 안전함을 확인했다(ResponseBodyTests).
    /// 참조 구현(JS)은 더 깊어도 받는다. 알려진 차이.
    static let maxDepth = 512

    init(bytes: [UInt8]) { self.bytes = bytes }

    func error(_ m: String) -> JSONParseError { JSONParseError(message: m, offset: i) }

    mutating func skipWS() {
        while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x0D || bytes[i] == 0x09 { i += 1 }
    }

    mutating func literal(_ word: String, _ v: JSONValue) throws -> JSONValue {
        let w = Array(word.utf8)
        guard i + w.count <= bytes.count, Array(bytes[i..<i + w.count]) == w else { throw error("invalid literal") }
        i += w.count
        return v
    }

    /// 열린 배열·객체. 클래스라 제자리에서 덧붙인다(복사 없음).
    private final class Open {
        let isObject: Bool
        var array: [JSONValue] = []
        var object = JSONObject()
        var key = ""
        init(isObject: Bool) { self.isObject = isObject }
    }

    /// `"키"` 와 `:` 를 읽는다.
    private mutating func key() throws -> String {
        guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw error("expected string key") }
        let k = try string()
        skipWS()
        guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw error("expected ':'") }
        i += 1
        skipWS()
        return k
    }

    mutating func document() throws -> JSONValue {
        var stack: [Open] = []
        while true {
            // 값 하나의 시작
            guard i < bytes.count else { throw error("unexpected end") }
            var v: JSONValue
            switch bytes[i] {
            case UInt8(ascii: "{"), UInt8(ascii: "["):
                let isObject = bytes[i] == UInt8(ascii: "{")
                guard stack.count < Self.maxDepth else { throw error("nesting too deep") }  // 빈 [] {} 도 한 단
                i += 1
                skipWS()
                if i < bytes.count, bytes[i] == UInt8(ascii: isObject ? "}" : "]") {
                    i += 1
                    v = isObject ? .object([:]) : .array([])
                } else {
                    let o = Open(isObject: isObject)
                    if isObject { o.key = try key() }
                    stack.append(o)
                    continue
                }
            case UInt8(ascii: "\""): v = .string(try string())
            case UInt8(ascii: "t"): v = try literal("true", .bool(true))
            case UInt8(ascii: "f"): v = try literal("false", .bool(false))
            case UInt8(ascii: "n"): v = try literal("null", .null)
            default: v = try number()
            }
            // 끝난 값을 부모에 넣고, 닫히는 괄호가 이어지면 계속 올라간다
            while true {
                guard let top = stack.last else { return v }
                if top.isObject { top.object[top.key] = v } else { top.array.append(v) }
                skipWS()
                guard i < bytes.count else { throw error("unexpected end") }
                let b = bytes[i]
                if b == UInt8(ascii: ",") {
                    i += 1
                    skipWS()
                    if top.isObject { top.key = try key() }
                    break  // 다음 값
                }
                guard b == UInt8(ascii: top.isObject ? "}" : "]") else {
                    throw error(top.isObject ? "expected ',' or '}'" : "expected ',' or ']'")
                }
                i += 1
                stack.removeLast()
                v = top.isObject ? .object(top.object) : .array(top.array)
            }
        }
    }

    mutating func number() throws -> JSONValue {
        let start = i
        func isDigit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }
        if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
        guard i < bytes.count, isDigit(bytes[i]) else { throw error("invalid number") }
        if bytes[i] == 0x30 {
            i += 1
        } else {
            while i < bytes.count, isDigit(bytes[i]) { i += 1 }
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
            i += 1
            guard i < bytes.count, isDigit(bytes[i]) else { throw error("invalid number") }
            while i < bytes.count, isDigit(bytes[i]) { i += 1 }
        }
        if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
            i += 1
            if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
            guard i < bytes.count, isDigit(bytes[i]) else { throw error("invalid number") }
            while i < bytes.count, isDigit(bytes[i]) { i += 1 }
        }
        let s = String(decoding: bytes[start..<i], as: UTF8.self)
        guard let d = Double(s) else { throw error("invalid number") }
        return .number(d)
    }

    mutating func hex4() throws -> UInt16 {
        guard i + 4 <= bytes.count else { throw error("bad \\u escape") }
        var v: UInt16 = 0
        for _ in 0..<4 {
            let b = bytes[i]
            let d: UInt16
            switch b {
            case 0x30...0x39: d = UInt16(b - 0x30)
            case 0x41...0x46: d = UInt16(b - 0x41 + 10)
            case 0x61...0x66: d = UInt16(b - 0x61 + 10)
            default: throw error("bad \\u escape")
            }
            v = v << 4 | d
            i += 1
        }
        return v
    }

    mutating func string() throws -> String {
        i += 1  // 여는 따옴표
        var out: [UInt8] = []
        while true {
            guard i < bytes.count else { throw error("unterminated string") }
            let b = bytes[i]
            if b == UInt8(ascii: "\"") { i += 1; break }
            if b < 0x20 { throw error("control character in string") }
            if b != UInt8(ascii: "\\") { out.append(b); i += 1; continue }
            i += 1
            guard i < bytes.count else { throw error("unterminated string") }
            let e = bytes[i]
            i += 1
            switch e {
            case UInt8(ascii: "\""): out.append(0x22)
            case UInt8(ascii: "\\"): out.append(0x5C)
            case UInt8(ascii: "/"): out.append(0x2F)
            case UInt8(ascii: "b"): out.append(0x08)
            case UInt8(ascii: "f"): out.append(0x0C)
            case UInt8(ascii: "n"): out.append(0x0A)
            case UInt8(ascii: "r"): out.append(0x0D)
            case UInt8(ascii: "t"): out.append(0x09)
            case UInt8(ascii: "u"):
                let u = try hex4()
                var scalar: Unicode.Scalar?
                if (0xD800...0xDBFF).contains(u), i + 6 <= bytes.count, bytes[i] == 0x5C, bytes[i + 1] == UInt8(ascii: "u") {
                    let save = i
                    i += 2
                    let lo = try hex4()
                    if (0xDC00...0xDFFF).contains(lo) {
                        scalar = Unicode.Scalar(0x10000 + ((UInt32(u) - 0xD800) << 10) + (UInt32(lo) - 0xDC00))
                    } else {
                        i = save
                    }
                } else {
                    scalar = Unicode.Scalar(UInt32(u))
                }
                // 짝 없는 서로게이트는 U+FFFD (UTF-16 길이 1 로 같다)
                out.append(contentsOf: Array(String(Character(scalar ?? "\u{FFFD}")).utf8))
            default:
                throw error("bad escape")
            }
        }
        return String(decoding: out, as: UTF8.self)
    }
}

// MARK: - 직렬화

extension JSONValue {
    /// 압축 JSON 문자열. 객체 키는 정렬해 결정적으로 낸다.
    public func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += Self.formatNumber(n)
        case .string(let s): Self.writeString(s, to: &out)
        case .array(let a):
            out += "["
            for (idx, v) in a.enumerated() {
                if idx > 0 { out += "," }
                v.write(to: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            for (idx, k) in o.keys.sorted().enumerated() {
                if idx > 0 { out += "," }
                Self.writeString(k, to: &out)
                out += ":"
                o[k]!.write(to: &out)
            }
            out += "}"
        }
    }

    static func formatNumber(_ n: Double) -> String {
        guard n.isFinite else { return "null" }  // JSON.stringify 와 같다
        if n == n.rounded(), abs(n) < 9_007_199_254_740_992 { return String(Int64(n)) }
        return "\(n)"
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    let h = String(u.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - h.count) + h
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }
}

// MARK: - Codable (앱 모델과 오갈 때 편의용)

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode(JSONObject.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
