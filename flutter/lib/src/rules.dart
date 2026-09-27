// 명세의 순수 규칙들 (SPEC 3.1, 3.2, 4절). 라우터와 테스트가 같이 쓴다.
import 'dart:convert';

import 'config.dart';
import 'types.dart';

const contextPatterns = ['context length', 'context_length', 'maximum context', 'too many tokens'];

/// 3.1: `(UTF-16 코드 유닛 수 + 3) ~/ 4`. Dart `String.length` 는 UTF-16 코드 유닛 수다.
int estimateTokens(Map<String, Object?> request) {
  var units = 0;
  final messages = request['messages'];
  if (messages is! List) return 0;
  for (final m in messages) {
    if (m is! Map) continue;
    final c = m['content'];
    if (c is String) {
      units += c.length;
    } else if (c is List) {
      for (final part in c) {
        if (part is Map) {
          final t = part['text'];
          if (t is String) units += t.length;
        }
      }
    }
  }
  return (units + 3) ~/ 4;
}

bool isRetryableStatus(int status) =>
    status == 404 || status == 408 || status == 429 || (status >= 500 && status <= 599);

/// ASCII A–Z 만 a–z 로. 로캘·유니코드 소문자화를 쓰지 않는다 (4절).
String asciiLower(String text) {
  final units = text.codeUnits;
  List<int>? out;
  for (var i = 0; i < units.length; i++) {
    final c = units[i];
    if (c >= 0x41 && c <= 0x5A) {
      out ??= List.of(units);
      out[i] = c + 32;
    }
  }
  return out == null ? text : String.fromCharCodes(out);
}

bool isContextError(int status, String text) {
  if (status != 400 && status != 413) return false;
  final lower = asciiLower(text);
  return contextPatterns.any(lower.contains);
}

/// 4절 분류 결과. [json] 은 2xx 이고 JSON 객체였을 때만.
class Classified {
  const Classified(this.outcome, this.json);
  final Outcome outcome;
  final Map<String, Object?>? json;
}

Classified classifyResponse(int status, String text) {
  if (status >= 200 && status <= 299) {
    Object? json;
    try {
      json = jsonDecode(text);
    } on FormatException {
      return const Classified(Outcome.badBody, null);
    }
    if (json is! Map<String, Object?>) return const Classified(Outcome.badBody, null);
    if (json['error'] != null) return Classified(Outcome.badBody, json);
    final choices = json['choices'];
    if (choices is! List || choices.isEmpty) return Classified(Outcome.badBody, json);
    return Classified(Outcome.ok, json);
  }
  if (isContextError(status, text)) return const Classified(Outcome.contextExceeded, null);
  if (isRetryableStatus(status)) return const Classified(Outcome.retryableStatus, null);
  return const Classified(Outcome.fatalStatus, null);
}

/// 2절 pickWeighted. rng 는 정확히 한 번 부른다.
DeploymentConfig pickWeighted(List<DeploymentConfig> candidates, double Function() rng) {
  var total = 0.0;
  for (final d in candidates) {
    total += d.rpm;
  }
  final r = rng() * total;
  var acc = 0.0;
  for (final d in candidates) {
    acc += d.rpm;
    if (acc > r) return d;
  }
  return candidates.last;
}
