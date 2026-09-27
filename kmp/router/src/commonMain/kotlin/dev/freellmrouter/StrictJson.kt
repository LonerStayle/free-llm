package dev.freellmrouter

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * RFC 8259 문법을 지킨 JSON 만 파싱한다. 틀리면 IllegalArgumentException.
 * kotlinx 의 parseToJsonElement 는 따옴표 없는 값(abc, 01, NaN)도 받아들여서 참조 구현(JSON.parse)과 갈린다.
 * kotlinx 는 재귀로 읽어 깊은 중첩에서 스택이 넘치므로(StackOverflowError, native 는 프로세스 종료)
 * 중첩 깊이 [MAX_JSON_DEPTH] 를 넘으면 거부한다. 이 점만 JSON.parse 와 다르다.
 */
internal fun parseStrictJson(text: String): JsonElement {
    require(isStrictJson(text)) { "invalid JSON" }
    return Json.parseToJsonElement(text)
}

internal const val MAX_JSON_DEPTH = 256

// 재귀 없이 컨테이너 스택으로 검사한다
internal fun isStrictJson(s: String, maxDepth: Int = MAX_JSON_DEPTH): Boolean {
    val n = s.length
    var i = 0
    val stack = StringBuilder() // '{' 또는 '['

    fun ws() {
        while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
    }

    fun isHex(c: Char) = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

    fun digits(): Int {
        val start = i
        while (i < n && s[i] in '0'..'9') i++
        return i - start
    }

    fun str(): Boolean { // s[i] == '"'
        i++
        while (i < n) {
            val c = s[i]
            when {
                c == '"' -> { i++; return true }
                c == '\\' -> {
                    i++
                    if (i >= n) return false
                    when (s[i]) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> i++
                        'u' -> {
                            if (i + 4 >= n) return false
                            for (k in 1..4) if (!isHex(s[i + k])) return false
                            i += 5
                        }
                        else -> return false
                    }
                }
                c < ' ' -> return false // 제어 문자는 이스케이프해야 한다
                else -> i++
            }
        }
        return false
    }

    fun num(): Boolean {
        if (i < n && s[i] == '-') i++
        if (i >= n) return false
        when (s[i]) {
            '0' -> i++
            in '1'..'9' -> digits()
            else -> return false
        }
        if (i < n && s[i] == '.') {
            i++
            if (digits() == 0) return false
        }
        if (i < n && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < n && (s[i] == '+' || s[i] == '-')) i++
            if (digits() == 0) return false
        }
        return true
    }

    fun lit(word: String): Boolean {
        if (!s.startsWith(word, i)) return false
        i += word.length
        return true
    }

    fun key(): Boolean {
        ws()
        if (i >= n || s[i] != '"' || !str()) return false
        ws()
        if (i >= n || s[i] != ':') return false
        i++
        return true
    }

    value@ while (true) {
        ws()
        if (i >= n) return false
        when (s[i]) {
            '{' -> {
                if (stack.length >= maxDepth) return false // 빈 컨테이너도 한 단계로 센다
                i++
                ws()
                if (i < n && s[i] == '}') {
                    i++
                } else {
                    stack.append('{')
                    if (!key()) return false
                    continue@value
                }
            }
            '[' -> {
                if (stack.length >= maxDepth) return false // 빈 컨테이너도 한 단계로 센다
                i++
                ws()
                if (i < n && s[i] == ']') {
                    i++
                } else {
                    stack.append('[')
                    continue@value
                }
            }
            '"' -> if (!str()) return false
            't' -> if (!lit("true")) return false
            'f' -> if (!lit("false")) return false
            'n' -> if (!lit("null")) return false
            else -> if (!num()) return false
        }
        // 값 하나를 끝냈다: 컨테이너를 닫거나 ',' 로 다음 값으로
        while (true) {
            ws()
            if (stack.isEmpty()) return i == n
            if (i >= n) return false
            val top = stack[stack.length - 1]
            val c = s[i]
            when {
                c == ',' -> {
                    i++
                    if (top == '{' && !key()) return false
                    continue@value
                }
                (top == '{' && c == '}') || (top == '[' && c == ']') -> {
                    i++
                    stack.deleteAt(stack.length - 1)
                }
                else -> return false
            }
        }
    }
}
