package dev.freellmrouter

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.floor

data class Provider(
    val id: String,
    val baseUrl: String,
    val keyName: String?,
    val extraHeaders: Map<String, String>,
)

data class Deployment(
    val id: String,
    val provider: String,
    val model: String,
    val rpm: Int,
    val maxInputTokens: Int?,
    val enabled: Boolean,
)

data class Settings(
    val numRetries: Int = 3,
    val allowedFails: Int = 3,
    val cooldownSeconds: Double = 60.0,
    val timeoutSeconds: Double = 60.0,
    val fallbacks: Map<String, List<String>> = emptyMap(),
    val contextWindowFallbacks: Map<String, List<String>> = emptyMap(),
) {
    /** 실패 창 = 쿨다운 길이 (ms, 반올림) */
    val cooldownMs: Long get() = secondsToMs(cooldownSeconds)
    val timeoutMs: Long get() = secondsToMs(timeoutSeconds)
}

/** [parseConfig] 로만 만든다. */
class Config internal constructor(
    val providers: Map<String, Provider>,
    /** 그룹 이름 → 배포 목록 (설정 순서) */
    val groups: Map<String, List<Deployment>>,
    val settings: Settings,
)

// 양수라 .5 는 올림 (JS Math.round 와 같게). kotlin.math.round 는 짝수 반올림이라 쓰지 않는다.
internal fun secondsToMs(s: Double): Long = floor(s * 1000.0 + 0.5).toLong()

private const val INT_MAX = 2147483647.0
private val FORBIDDEN_HEADER = Regex("^(authorization|content-type)$", RegexOption.IGNORE_CASE)

/** models.json 형식 문자열 → [Config]. 잘못되면 [ConfigError] (SPEC 6절). */
@Throws(ConfigError::class)
fun parseConfig(json: String): Config {
    val raw = try {
        parseStrictJson(json)
    } catch (e: Exception) {
        throw ConfigError("invalid JSON: ${e.message}")
    }
    return normalizeConfig(raw)
}

// JSON null 은 "없음"
private fun JsonObject.opt(key: String): JsonElement? = this[key]?.takeUnless { it is JsonNull }

private fun JsonElement?.asNonEmptyString(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() }?.content

private fun JsonElement?.asNumber(): Double? {
    val p = this as? JsonPrimitive ?: return null
    if (p.isString || p is JsonNull) return null
    val c = p.content
    if (c == "true" || c == "false") return null
    return c.toDoubleOrNull()
}

// 정수 = 소수부가 0 인 JSON 수 (4, 4.0 모두 4). 범위 [min, 2147483647]
private fun JsonElement?.asInt(min: Int): Int? {
    val d = asNumber() ?: return null
    if (!d.isFinite() || d != floor(d) || d < min || d > INT_MAX) return null
    return d.toInt()
}

private fun JsonElement?.asBoolean(): Boolean? {
    val p = this as? JsonPrimitive ?: return null
    if (p.isString) return null
    return when (p.content) {
        "true" -> true
        "false" -> false
        else -> null
    }
}

private fun fail(msg: String): Nothing = throw ConfigError(msg)

internal fun normalizeConfig(raw: JsonElement): Config {
    if (raw !is JsonObject) fail("config must be an object")
    raw.opt("version")?.let { if (it.asNumber() != 1.0) fail("unsupported version: $it") }

    val rawProviders = raw["providers"] as? JsonArray ?: fail("providers must be an array")
    val providers = LinkedHashMap<String, Provider>()
    for (p in rawProviders) {
        if (p !is JsonObject) fail("provider must be an object")
        val id = p["id"].asNonEmptyString() ?: fail("provider.id required")
        if (id in providers) fail("duplicate provider id: $id")
        val baseUrl = p["baseUrl"].asNonEmptyString() ?: fail("provider $id: baseUrl required")
        val keyName = p.opt("keyName")?.let {
            (it as? JsonPrimitive)?.takeIf { v -> v.isString }?.content ?: fail("provider $id: keyName must be a string")
        }
        val extraRaw = p.opt("extraHeaders") ?: JsonObject(emptyMap())
        if (extraRaw !is JsonObject) fail("provider $id: extraHeaders must be an object")
        val extra = LinkedHashMap<String, String>()
        for ((h, v) in extraRaw) {
            if (FORBIDDEN_HEADER.matches(h)) fail("provider $id: extraHeaders must not set $h")
            val s = (v as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: fail("provider $id: extraHeaders.$h must be a string")
            extra[h] = s
        }
        providers[id] = Provider(id, baseUrl, keyName, extra)
    }

    val rawGroups = raw["groups"] as? JsonObject ?: fail("groups must be an object")
    val groups = LinkedHashMap<String, List<Deployment>>()
    val seen = HashSet<String>()
    for ((name, g) in rawGroups) {
        val list = (g as? JsonObject)?.get("deployments") as? JsonArray
            ?: fail("group $name: deployments must be an array")
        groups[name] = list.map { d ->
            if (d !is JsonObject) fail("group $name: deployment must be an object")
            val id = d["id"].asNonEmptyString() ?: fail("group $name: deployment.id required")
            if (!seen.add(id)) fail("duplicate deployment id: $id")
            val provider = (d["provider"] as? JsonPrimitive)?.takeIf { it.isString && it.content in providers }?.content
                ?: fail("deployment $id: unknown provider ${d["provider"]}")
            val model = d["model"].asNonEmptyString() ?: fail("deployment $id: model required")
            val rpm = d["rpm"].asInt(1) ?: fail("deployment $id: rpm must be an integer in [1, 2147483647]")
            val maxInputTokens = d.opt("maxInputTokens")?.let {
                it.asInt(1) ?: fail("deployment $id: maxInputTokens must be an integer in [1, 2147483647]")
            }
            val enabled = d.opt("enabled")?.let { it.asBoolean() ?: fail("deployment $id: enabled must be a boolean") } ?: true
            Deployment(id, provider, model, rpm, maxInputTokens, enabled)
        }
    }

    val rs = raw.opt("settings") ?: JsonObject(emptyMap())
    if (rs !is JsonObject) fail("settings must be an object")
    val d = Settings()
    val numRetries = rs.opt("numRetries")?.let { it.asInt(0) ?: fail("settings.numRetries must be an integer >= 0") } ?: d.numRetries
    val allowedFails = rs.opt("allowedFails")?.let { it.asInt(1) ?: fail("settings.allowedFails must be an integer >= 1") } ?: d.allowedFails
    fun positive(key: String, dflt: Double): Double {
        val v = rs.opt(key) ?: return dflt
        val n = v.asNumber()
        if (n == null || !n.isFinite() || !(n > 0)) fail("settings.$key must be a number > 0")
        return n
    }
    val cooldownSeconds = positive("cooldownSeconds", d.cooldownSeconds)
    val timeoutSeconds = positive("timeoutSeconds", d.timeoutSeconds)
    fun groupMap(key: String): Map<String, List<String>> {
        val v = rs.opt(key) ?: return emptyMap()
        if (v !is JsonObject) fail("settings.$key must be an object")
        val out = LinkedHashMap<String, List<String>>()
        for ((from, list) in v) {
            if (from !in groups) fail("settings.$key: unknown group $from")
            if (list !is JsonArray) fail("settings.$key.$from must be an array")
            out[from] = list.map { to ->
                (to as? JsonPrimitive)?.takeIf { it.isString && it.content in groups }?.content
                    ?: fail("settings.$key.$from: unknown group $to")
            }
        }
        return out
    }
    val settings = Settings(
        numRetries = numRetries,
        allowedFails = allowedFails,
        cooldownSeconds = cooldownSeconds,
        timeoutSeconds = timeoutSeconds,
        fallbacks = groupMap("fallbacks"),
        contextWindowFallbacks = groupMap("contextWindowFallbacks"),
    )
    return Config(providers, groups, settings)
}
