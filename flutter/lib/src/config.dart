import 'dart:convert';

import 'rules.dart';
import 'types.dart';

class ProviderConfig {
  const ProviderConfig({
    required this.id,
    required this.baseUrl,
    required this.keyName,
    required this.extraHeaders,
  });

  final String id;
  final String baseUrl;

  /// 앱이 키를 찾을 때 쓰는 이름 (dart-define 이름 등). 라우터는 쓰지 않는다.
  final String? keyName;
  final Map<String, String> extraHeaders;
}

class DeploymentConfig {
  const DeploymentConfig({
    required this.id,
    required this.provider,
    required this.model,
    required this.rpm,
    required this.maxInputTokens,
    required this.enabled,
  });

  final String id;
  final String provider;
  final String model;
  final int rpm;
  final int? maxInputTokens;
  final bool enabled;
}

class RouterSettings {
  const RouterSettings({
    required this.numRetries,
    required this.allowedFails,
    required this.cooldownSeconds,
    required this.timeoutSeconds,
    required this.fallbacks,
    required this.contextWindowFallbacks,
  });

  final int numRetries;
  final int allowedFails;
  final num cooldownSeconds;
  final num timeoutSeconds;
  final Map<String, List<String>> fallbacks;
  final Map<String, List<String>> contextWindowFallbacks;

  /// 초 → 밀리초, 가장 가까운 정수 (양수라 .5 는 올림).
  /// 터무니없이 큰 값은 2^53-1 ms(약 28만 년)로 자른다: `now + ms` 가 int 범위를 넘지 않게.
  int get cooldownMs => _secondsToMs(cooldownSeconds);
  int get timeoutMs => _secondsToMs(timeoutSeconds);
}

const _maxMs = 9007199254740991; // 2^53-1

int _secondsToMs(num seconds) {
  final ms = seconds * 1000;
  return ms >= _maxMs ? _maxMs : ms.round();
}

/// `parseConfig` 결과. 그룹과 배포 순서는 설정 순서 그대로.
class Config {
  const Config._(this.providers, this.groups, this.settings);

  final Map<String, ProviderConfig> providers;
  final Map<String, List<DeploymentConfig>> groups;
  final RouterSettings settings;

  /// 이미 디코드한 JSON 값(models.json 형식)에서 만든다. 잘못되면(키가 문자열이 아닌 맵 포함) [ConfigError].
  factory Config.fromJson(Object? json) => _normalize(json);
}

/// models.json 형식 문자열 → [Config]. 잘못되면 [ConfigError] (SPEC 6절).
Config parseConfig(String json) {
  Object? raw;
  try {
    raw = jsonDecode(json);
  } on FormatException catch (e) {
    throw ConfigError('invalid JSON: ${e.message}');
  }
  return Config.fromJson(raw);
}

const _intMax = 2147483647;

// 정수 = JSON 수 중 소수부가 0 인 것 (4, 4.0 모두 4). 아니면 null.
int? _asInt(Object? v, int min) {
  int? i;
  if (v is int) {
    i = v;
  } else if (v is double && v.isFinite && v == v.truncateToDouble() && v.abs() <= 1e15) {
    i = v.toInt();
  }
  if (i == null || i < min || i > _intMax) return null;
  return i;
}

bool _nonEmptyStr(Object? v) => v is String && v.isNotEmpty;

Config _normalize(Object? raw) {
  if (raw is! Map) throw const ConfigError('config must be an object');
  final version = raw['version'];
  if (version != null && version != 1) throw ConfigError('unsupported version: $version');

  final rawProviders = raw['providers'];
  if (rawProviders is! List) throw const ConfigError('providers must be an array');
  final providers = <String, ProviderConfig>{};
  for (final p in rawProviders) {
    if (p is! Map) throw const ConfigError('provider must be an object');
    final id = p['id'];
    if (!_nonEmptyStr(id)) throw const ConfigError('provider.id required');
    id as String;
    if (providers.containsKey(id)) throw ConfigError('duplicate provider id: $id');
    final baseUrl = p['baseUrl'];
    if (!_nonEmptyStr(baseUrl)) throw ConfigError('provider $id: baseUrl required');
    final keyName = p['keyName'];
    if (keyName != null && keyName is! String) throw ConfigError('provider $id: keyName must be a string');
    final extra = p['extraHeaders'] ?? const <String, Object?>{};
    if (extra is! Map) throw ConfigError('provider $id: extraHeaders must be an object');
    final headers = <String, String>{};
    for (final MapEntry(:key, :value) in extra.entries) {
      if (key is! String) throw ConfigError('provider $id: extraHeaders keys must be strings');
      final h = key;
      final lower = asciiLower(h);
      if (lower == 'authorization' || lower == 'content-type') {
        throw ConfigError('provider $id: extraHeaders must not set $h');
      }
      if (value is! String) throw ConfigError('provider $id: extraHeaders.$h must be a string');
      headers[h] = value;
    }
    providers[id] = ProviderConfig(
      id: id,
      baseUrl: baseUrl as String,
      keyName: keyName as String?,
      extraHeaders: Map.unmodifiable(headers),
    );
  }

  final rawGroups = raw['groups'];
  if (rawGroups is! Map) throw const ConfigError('groups must be an object');
  final groups = <String, List<DeploymentConfig>>{};
  final seen = <String>{};
  for (final MapEntry(:key, :value) in rawGroups.entries) {
    if (key is! String) throw const ConfigError('groups keys must be strings');
    final name = key;
    final g = value;
    if (g is! Map || g['deployments'] is! List) {
      throw ConfigError('group $name: deployments must be an array');
    }
    final list = <DeploymentConfig>[];
    for (final d in g['deployments'] as List) {
      if (d is! Map) throw ConfigError('group $name: deployment must be an object');
      final id = d['id'];
      if (!_nonEmptyStr(id)) throw ConfigError('group $name: deployment.id required');
      id as String;
      if (!seen.add(id)) throw ConfigError('duplicate deployment id: $id');
      final provider = d['provider'];
      if (provider is! String || !providers.containsKey(provider)) {
        throw ConfigError('deployment $id: unknown provider $provider');
      }
      final model = d['model'];
      if (!_nonEmptyStr(model)) throw ConfigError('deployment $id: model required');
      final rpm = _asInt(d['rpm'], 1);
      if (rpm == null) throw ConfigError('deployment $id: rpm must be an integer in [1, $_intMax]');
      int? maxInputTokens;
      if (d['maxInputTokens'] != null) {
        maxInputTokens = _asInt(d['maxInputTokens'], 1);
        if (maxInputTokens == null) {
          throw ConfigError('deployment $id: maxInputTokens must be an integer in [1, $_intMax]');
        }
      }
      final enabled = d['enabled'];
      if (enabled != null && enabled is! bool) throw ConfigError('deployment $id: enabled must be a boolean');
      list.add(DeploymentConfig(
        id: id,
        provider: provider,
        model: model as String,
        rpm: rpm,
        maxInputTokens: maxInputTokens,
        enabled: (enabled as bool?) ?? true,
      ));
    }
    groups[name] = List.unmodifiable(list);
  }

  final rs = raw['settings'] ?? const <String, Object?>{};
  if (rs is! Map) throw const ConfigError('settings must be an object');
  Object? s(String k, Object dflt) => rs[k] ?? dflt;

  final numRetries = _asInt(s('numRetries', 3), 0);
  if (numRetries == null) throw const ConfigError('settings.numRetries must be an integer >= 0');
  final allowedFails = _asInt(s('allowedFails', 3), 1);
  if (allowedFails == null) throw const ConfigError('settings.allowedFails must be an integer >= 1');
  num positive(String k) {
    final v = s(k, 60);
    if (v is! num || !v.isFinite || !(v > 0)) throw ConfigError('settings.$k must be a number > 0');
    return v;
  }

  final cooldownSeconds = positive('cooldownSeconds');
  final timeoutSeconds = positive('timeoutSeconds');
  Map<String, List<String>> fallbackMap(String k) {
    final v = s(k, const <String, Object?>{});
    if (v is! Map) throw ConfigError('settings.$k must be an object');
    final out = <String, List<String>>{};
    for (final MapEntry(:key, :value) in v.entries) {
      if (key is! String) throw ConfigError('settings.$k keys must be strings');
      final from = key;
      if (!groups.containsKey(from)) throw ConfigError('settings.$k: unknown group $from');
      if (value is! List) throw ConfigError('settings.$k.$from must be an array');
      for (final to in value) {
        if (to is! String || !groups.containsKey(to)) {
          throw ConfigError('settings.$k.$from: unknown group $to');
        }
      }
      out[from] = List.unmodifiable(value.cast<String>());
    }
    return Map.unmodifiable(out);
  }

  final settings = RouterSettings(
    numRetries: numRetries,
    allowedFails: allowedFails,
    cooldownSeconds: cooldownSeconds,
    timeoutSeconds: timeoutSeconds,
    fallbacks: fallbackMap('fallbacks'),
    contextWindowFallbacks: fallbackMap('contextWindowFallbacks'),
  );
  return Config._(Map.unmodifiable(providers), Map.unmodifiable(groups), settings);
}
