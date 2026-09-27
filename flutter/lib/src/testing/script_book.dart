// spec/mock-server/server.mjs 의 ScriptBook·materialize·validateResponses 를 옮긴 것.
// 메모리 transport 가 모의 서버와 같은 응답을 내도록 한다.
import 'dart:convert';

Map<String, Object?> defaultCompletion(String model, int seq) => {
      'id': 'mock-$seq',
      'object': 'chat.completion',
      'created': 0,
      'model': model,
      'choices': [
        {
          'index': 0,
          'message': {'role': 'assistant', 'content': 'ok:$model'},
          'finish_reason': 'stop',
        }
      ],
      'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
    };

class ScriptedResponse {
  const ScriptedResponse({
    required this.status,
    required this.text,
    required this.delayMs,
    required this.bodyDelayMs,
    required this.close,
  });

  final int status;
  final String text;
  final num delayMs;
  final num bodyDelayMs;

  /// `action: "close"` → 응답 없이 연결 끊기.
  final bool close;
}

ScriptedResponse materialize(Map<String, Object?> entry, String model, int seq) {
  final status = (entry['status'] as int?) ?? 200;
  final body = entry['body'];
  final String text;
  if (!entry.containsKey('body')) {
    text = jsonEncode(status >= 200 && status <= 299
        ? defaultCompletion(model, seq)
        : {
            'error': {'message': 'mock status $status', 'code': status}
          });
  } else if (body is String) {
    text = body;
  } else {
    text = jsonEncode(body);
  }
  return ScriptedResponse(
    status: status,
    text: text,
    delayMs: (entry['delayMs'] as num?) ?? 0,
    bodyDelayMs: (entry['bodyDelayMs'] as num?) ?? 0,
    close: entry['action'] == 'close',
  );
}

/// 잘못되면 이유, 괜찮으면 null.
String? validateResponses(Object? responses) {
  if (responses is! Map) return 'responses must be an object';
  final headerName = RegExp(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");
  for (final MapEntry(:key, :value) in responses.entries) {
    if (value is! List) return 'responses.$key must be an array';
    for (var i = 0; i < value.length; i++) {
      final e = value[i];
      final at = 'responses.$key[$i]';
      if (e is! Map) return '$at must be an object';
      final status = e['status'];
      if (e.containsKey('status') && !(status is int && status >= 200 && status <= 599)) {
        return '$at.status must be an integer 200..599';
      }
      if (e.containsKey('body') && !(e['body'] is String || e['body'] is Map || e['body'] is List)) {
        return '$at.body must be a string or JSON object/array';
      }
      for (final k in ['delayMs', 'bodyDelayMs']) {
        final v = e[k];
        if (e.containsKey(k) && !(v is num && v.isFinite && v >= 0)) return '$at.$k must be a number >= 0';
      }
      if (e.containsKey('action') && e['action'] != 'close') return '$at.action must be "close"';
      if (e.containsKey('headers')) {
        final h = e['headers'];
        if (h is! Map) return '$at.headers must be an object';
        for (final MapEntry(key: hk, value: hv) in h.entries) {
          if (hk is! String || !headerName.hasMatch(hk)) return '$at.headers: invalid name $hk';
          if (hv is! String || RegExp('[\r\n\u0000]').hasMatch(hv)) {
            return '$at.headers.$hk must be a string without CR/LF';
          }
        }
      }
    }
  }
  return null;
}

/// model 별 응답 스크립트. 순서대로 소비하고, 다 쓰면 기본 200.
class ScriptBook {
  ScriptBook(this.responses);

  final Map<String, Object?> responses;
  final Map<String, int> _used = {};
  int _seq = 0;

  ScriptedResponse next(String model) {
    final list = (responses[model] as List?) ?? const [];
    final i = _used[model] ?? 0;
    _used[model] = i + 1;
    _seq++;
    final entry = i < list.length ? (list[i] as Map).cast<String, Object?>() : const <String, Object?>{};
    return materialize(entry, model, _seq);
  }
}
