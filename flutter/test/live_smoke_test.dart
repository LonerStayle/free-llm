// 실제 제공처 스모크 (spec/live-smoke.md). OPENROUTER_API_KEY 가 없으면 LIVE SKIP.
//   OPENROUTER_API_KEY=... dart test --tags live
// 키는 환경변수에서만 읽는다. 키·Authorization 은 출력하지 않는다.
@Tags(['live'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:free_llm_router/free_llm_router.dart';
import 'package:test/test.dart';

import 'support/spec_files.dart';

void main() {
  test('live smoke (fast, chat)', () async {
    final key = Platform.environment['OPENROUTER_API_KEY'];
    if (key == null || key.isEmpty) {
      // ignore: avoid_print
      print('LIVE SKIP OPENROUTER_API_KEY not set');
      markTestSkipped('OPENROUTER_API_KEY not set');
      return;
    }
    final raw = (jsonDecode(readSpecFile('models.json')) as Map).cast<String, Object?>();
    raw['settings'] = {...((raw['settings'] as Map?) ?? const {}), 'timeoutSeconds': 20};
    final router = LlmRouter(parseConfig(jsonEncode(raw)), {'openrouter': key});

    const totalLimit = Duration(minutes: 5);
    final total = CancelToken();
    final limitTimer = Timer(totalLimit, total.cancel);
    const request = {
      'messages': [
        {'role': 'user', 'content': 'Reply with the single word: pong'},
      ],
      'max_tokens': 256,
    };
    String fmt(List<Attempt> attempts) => attempts
        .map((a) =>
            '${a.deploymentId}:${a.outcome.value}${a.status != null ? ':${a.status}' : ''}:${a.durationMs}ms')
        .join(',');

    var failed = false;
    for (final group in ['fast', 'chat']) {
      final sw = Stopwatch()..start();
      try {
        final r = await router.route(group, request, cancelToken: total);
        final choices = r.response['choices'] as List;
        final message = (choices.first as Map)['message'];
        var content = '${message is Map ? message['content'] ?? '' : ''}'.replaceAll(RegExp(r'\s+'), ' ');
        if (content.length > 80) content = content.substring(0, 80);
        // ignore: avoid_print
        print(
            'LIVE $group ok deployment=${r.deploymentId} served_group=${r.group} ms=${sw.elapsedMilliseconds} '
            'attempts=[${fmt(r.attempts)}] content=${jsonEncode(content)}');
      } on RouteCancelledException {
        failed = true;
        // ignore: avoid_print
        print('LIVE TIMEOUT total>${totalLimit.inSeconds}s (group $group)');
        break;
      } on RouterError catch (e) {
        failed = true;
        // ignore: avoid_print
        print('LIVE $group FAIL kind=${e.kind.value} status=${e.status} ms=${sw.elapsedMilliseconds} '
            'attempts=[${fmt(e.attempts)}]');
      }
    }
    limitTimer.cancel();
    router.close();
    expect(failed, isFalse);
  }, timeout: const Timeout(Duration(minutes: 6)));
}
