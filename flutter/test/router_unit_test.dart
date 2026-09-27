// 적합성 시나리오가 직접 다루지 않는 Dart 쪽 세부 (취소·타임아웃 경로, 소켓 끊김, 규칙 함수).
import 'dart:async';
import 'dart:io';

import 'package:free_llm_router/free_llm_router.dart';
import 'package:free_llm_router/src/cancel.dart' show cancelListenerCount;
import 'package:free_llm_router/src/rules.dart';
import 'package:test/test.dart';

Config _config({num timeoutSeconds = 5, String baseUrl = 'http://mock.invalid/p1'}) => Config.fromJson({
      'providers': [
        {'id': 'p1', 'baseUrl': baseUrl},
      ],
      'groups': {
        'chat': {
          'deployments': [
            {'id': 'a', 'provider': 'p1', 'model': 'm-a', 'rpm': 1},
          ],
        },
      },
      'settings': {'timeoutSeconds': timeoutSeconds},
    });

const _req = {
  'messages': [
    {'role': 'user', 'content': 'hi'},
  ],
};

/// 결과를 직접 조종하는 transport.
class _FakeTransport implements Transport {
  _FakeTransport(this.handler);
  final Future<TransportResponse> Function(CancelToken cancel) handler;
  int calls = 0;

  @override
  Future<TransportResponse> send(String url, Map<String, String> headers, String body, CancelToken cancel) {
    calls++;
    return handler(cancel);
  }
}

void main() {
  group('rules', () {
    test('asciiLower changes only A-Z', () {
      expect(asciiLower('CONTEXT Length'), 'context length');
      expect(asciiLower('K'), 'K'); // 켈빈 기호는 그대로
      expect(asciiLower('İI'), 'İi');
    });

    test('estimateTokens counts UTF-16 units of string and text parts', () {
      expect(
        estimateTokens({
          'messages': [
            {'role': 'user', 'content': '😀'}, // 2 units
            {
              'role': 'user',
              'content': [
                {'type': 'text', 'text': 'abc'},
                {'type': 'image_url', 'image_url': {}},
                {'text': 5},
              ],
            },
            {'role': 'assistant', 'content': null},
            'not a map',
          ],
        }),
        (2 + 3 + 3) ~/ 4,
      );
    });

    test('classifyResponse', () {
      expect(classifyResponse(200, '{"choices":[{}]}').outcome, Outcome.ok);
      expect(classifyResponse(200, '{"choices":[]}').outcome, Outcome.badBody);
      expect(classifyResponse(200, '[]').outcome, Outcome.badBody);
      expect(classifyResponse(200, '{"error":null,"choices":[1]}').outcome, Outcome.ok);
      expect(classifyResponse(413, 'Too Many Tokens').outcome, Outcome.contextExceeded);
      expect(classifyResponse(413, 'payload').outcome, Outcome.fatalStatus);
      expect(classifyResponse(599, '').outcome, Outcome.retryableStatus);
      expect(classifyResponse(302, '').outcome, Outcome.fatalStatus);
    });

    test('string values match the spec', () {
      expect(Outcome.values.map((o) => o.value), [
        'ok',
        'retryable_status',
        'bad_body',
        'timeout',
        'network_error',
        'context_exceeded',
        'fatal_status',
      ]);
      expect(ErrorKind.values.map((k) => k.value), [
        'invalid_request',
        'non_retryable',
        'context_window_exceeded',
        'all_failed',
      ]);
    });
  });

  group('cancellation', () {
    test('cancel during a transport that ignores its token still returns promptly', () async {
      final t = _FakeTransport((_) => Completer<TransportResponse>().future); // 영원히 안 끝남
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0);
      final token = CancelToken();
      Timer(const Duration(milliseconds: 50), token.cancel);
      final sw = Stopwatch()..start();
      await expectLater(
          router.route('chat', _req, cancelToken: token), throwsA(isA<RouteCancelledException>()));
      expect(sw.elapsedMilliseconds, lessThan(500));
      expect(router.deploymentStates()['a']!.recentFailures, 0);
    });

    test('transport error caused by cancel is not network_error', () async {
      // 실제 HTTP 클라이언트처럼 토큰이 취소되면 예외로 끝나는 transport
      final t = _FakeTransport((cancel) async {
        await cancel.whenCancelled;
        throw const SocketException('aborted');
      });
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0);
      final token = CancelToken();
      Timer(const Duration(milliseconds: 20), token.cancel);
      await expectLater(
          router.route('chat', _req, cancelToken: token), throwsA(isA<RouteCancelledException>()));
      expect(router.deploymentStates()['a']!.recentFailures, 0);
    });

    test('already-cancelled token: no transport call', () async {
      final t = _FakeTransport((_) async => const TransportResponse(200, '{"choices":[1]}'));
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => throw StateError('rng used'));
      final token = CancelToken()..cancel();
      await expectLater(
          router.route('chat', _req, cancelToken: token), throwsA(isA<RouteCancelledException>()));
      expect(t.calls, 0);
    });

    test('invalid_request is checked before cancellation', () async {
      final router = LlmRouter(_config(), {'p1': 'k'});
      final token = CancelToken()..cancel();
      await expectLater(
        router.route('nope', _req, cancelToken: token),
        throwsA(isA<RouterError>().having((e) => e.kind, 'kind', ErrorKind.invalidRequest)),
      );
    });

    test('a long-lived token does not accumulate listeners', () async {
      final t = _FakeTransport((_) async => const TransportResponse(200, '{"choices":[1]}'));
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0);
      final token = CancelToken();
      for (var i = 0; i < 5; i++) {
        await router.route('chat', _req, cancelToken: token);
      }
      expect(cancelListenerCount(token), 0);
    });

    test('whenCancelled completes, isCancelled flips once', () async {
      final token = CancelToken();
      expect(token.isCancelled, isFalse);
      token.cancel();
      token.cancel();
      expect(token.isCancelled, isTrue);
      await token.whenCancelled;
    });
  });

  group('timeout and errors', () {
    test('router timer wins even if transport ignores its token', () async {
      final t = _FakeTransport((_) => Completer<TransportResponse>().future);
      final router = LlmRouter(_config(timeoutSeconds: 0.1), {'p1': 'k'}, transport: t, rng: () => 0);
      final err = await router.route('chat', _req).then<Object?>((_) => null, onError: (Object e) => e);
      expect(err, isA<RouterError>());
      final e = err as RouterError;
      expect(e.kind, ErrorKind.allFailed);
      expect(e.attempts.single.outcome, Outcome.timeout);
      expect(e.attempts.single.status, isNull);
    });

    test('transport that throws synchronously is network_error', () async {
      final t = _FakeTransport((_) => throw StateError('boom'));
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0);
      final err = await router.route('chat', _req).then<Object?>((_) => null, onError: (Object e) => e);
      expect((err as RouterError).attempts.single.outcome, Outcome.networkError);
      expect(router.deploymentStates()['a']!.recentFailures, 1);
    });

    test('resetState clears failures and cooldown', () async {
      final t = _FakeTransport((_) async => const TransportResponse(503, ''));
      var clock = 1000;
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0, now: () => clock);
      for (var i = 0; i < 3; i++) {
        await expectLater(router.route('chat', _req), throwsA(isA<RouterError>()));
      }
      expect(router.deploymentStates()['a']!.coolingDown, isTrue);
      router.resetState();
      final s = router.deploymentStates()['a']!;
      expect([s.coolingDown, s.cooldownUntilMs, s.recentFailures], [false, null, 0]);
      clock++;
    });
  });

  group('HttpTransport', () {
    test('cancel closes the in-flight socket', () async {
      // 요청을 받고 응답하지 않는 서버. 클라이언트가 소켓을 닫는지 본다.
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final closed = Completer<void>();
      final received = Completer<void>();
      server.listen((s) {
        s.listen((_) {
          if (!received.isCompleted) received.complete();
        }, onDone: () {
          if (!closed.isCompleted) closed.complete();
          s.destroy();
        }, onError: (Object _) {
          if (!closed.isCompleted) closed.complete();
        });
      });
      final transport = HttpTransport();
      final router = LlmRouter(
        _config(baseUrl: 'http://127.0.0.1:${server.port}/p1'),
        {'p1': 'k'},
        transport: transport,
        rng: () => 0,
      );
      final token = CancelToken();
      final future = router.route('chat', _req, cancelToken: token);
      await received.future.timeout(const Duration(seconds: 5));
      token.cancel();
      await expectLater(future, throwsA(isA<RouteCancelledException>()));
      await closed.future.timeout(const Duration(seconds: 2));
      transport.close();
      await server.close();
    });

    // dart:io 는 POST 에 대해 303 만 따라가므로(GET 으로 바꿔서) 303 이 핵심이다.
    for (final code in [301, 302, 303, 307, 308]) {
      test('does not follow $code and sends exact headers', () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final seen = <String, String>{};
        final hits = <String>[];
        server.listen((req) async {
          hits.add('${req.method} ${req.uri.path}');
          seen['content-type'] = req.headers.value('content-type') ?? '';
          seen['authorization'] = req.headers.value('authorization') ?? '';
          await req.drain<void>();
          if (req.uri.path == '/ok') {
            req.response.write('{"choices":[{"message":{"content":"followed"}}]}');
          } else {
            req.response
              ..statusCode = code
              ..headers.set('location', '/ok')
              ..write('moved');
          }
          await req.response.close();
        });
        final router = LlmRouter(
          _config(baseUrl: 'http://127.0.0.1:${server.port}/p1/'),
          {'p1': 'secret'},
          rng: () => 0,
        );
        final err = await router.route('chat', _req).then<Object?>((r) => r, onError: (Object e) => e);
        expect(err, isA<RouterError>());
        final e = err as RouterError;
        expect([e.kind, e.status, e.body], [ErrorKind.nonRetryable, code, 'moved']);
        expect(hits, ['POST /p1/chat/completions']);
        expect(seen, {'content-type': 'application/json', 'authorization': 'Bearer secret'});
        router.close();
        await server.close(force: true);
      });
    }
  });

  group('fallback queue', () {
    test('a group already queued is not queued again (diamond)', () async {
      // a → [b, c], b → [c]. c 는 한 번만 대기열에 들어가 한 번만 시도된다.
      final config = Config.fromJson({
        'providers': [
          {'id': 'p1', 'baseUrl': 'http://mock.invalid/p1'},
        ],
        'groups': {
          for (final g in ['a', 'b', 'c'])
            g: {
              'deployments': [
                {'id': 'd$g', 'provider': 'p1', 'model': 'm', 'rpm': 1},
              ],
            },
        },
        'settings': {
          'contextWindowFallbacks': {
            'a': ['b', 'c'],
            'b': ['c'],
          },
        },
      });
      final t = _FakeTransport((_) async => const TransportResponse(400, 'maximum context length exceeded'));
      final router = LlmRouter(config, {'p1': 'k'}, transport: t, rng: () => 0);
      final err = await router.route('a', _req).then<Object?>((r) => r, onError: (Object e) => e);
      final e = err as RouterError;
      expect(e.kind, ErrorKind.contextWindowExceeded);
      expect(e.attempts.map((x) => '${x.group}/${x.deploymentId}'), ['a/da', 'b/db', 'c/dc']);
      expect(e.message, contains('a → b → c'));
    });
  });

  group('cancellation timing', () {
    test('cancel landing right after the transport finished still cancels (check after transport)', () async {
      final token = CancelToken();
      // 응답이 done 을 먼저 채우고, route 가 재개되기 전에 취소가 들어오는 순서를 만든다.
      final t = _FakeTransport((_) {
        final c = Completer<TransportResponse>();
        Timer.run(() {
          c.complete(const TransportResponse(200, '{"choices":[1]}'));
          scheduleMicrotask(token.cancel);
        });
        return c.future;
      });
      final router = LlmRouter(_config(), {'p1': 'k'}, transport: t, rng: () => 0);
      await expectLater(
          router.route('chat', _req, cancelToken: token), throwsA(isA<RouteCancelledException>()));
      expect(router.deploymentStates()['a']!.recentFailures, 0);
    });
  });

  group('config edges', () {
    test('non-string map keys are ConfigError, not TypeError', () {
      Map<String, Object?> base() => {
            'providers': [
              {'id': 'p1', 'baseUrl': 'b'},
            ],
            'groups': <Object, Object?>{
              'g': {'deployments': []},
            },
          };
      final bad = [
        base()
          ..['providers'] = [
            {
              'id': 'p1',
              'baseUrl': 'b',
              'extraHeaders': {1: 'x'},
            },
          ],
        base()
          ..['groups'] = {
            1: {'deployments': []}
          },
        base()
          ..['settings'] = {
            'fallbacks': {
              1: ['g'],
            },
          },
      ];
      for (final c in bad) {
        expect(() => Config.fromJson(c), throwsA(isA<ConfigError>()));
      }
      expect(Config.fromJson(base()).groups.keys, ['g']);
    });

    test('huge cooldownSeconds still cools down (no int overflow)', () async {
      final config = Config.fromJson({
        'providers': [
          {'id': 'p1', 'baseUrl': 'http://mock.invalid/p1'},
        ],
        'groups': {
          'chat': {
            'deployments': [
              {'id': 'a', 'provider': 'p1', 'model': 'm', 'rpm': 1},
            ],
          },
        },
        'settings': {'allowedFails': 1, 'cooldownSeconds': 1e303, 'timeoutSeconds': 1e303},
      });
      final t = _FakeTransport((_) async => const TransportResponse(503, ''));
      final router = LlmRouter(config, {'p1': 'k'}, transport: t, rng: () => 0, now: () => 1000);
      await expectLater(router.route('chat', _req), throwsA(isA<RouterError>()));
      final s = router.deploymentStates()['a']!;
      expect(s.coolingDown, isTrue);
      expect(s.cooldownUntilMs, greaterThan(1000));
    });
  });

  group('close', () {
    test('close shuts the default transport but never an injected one', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        await req.drain<void>();
        req.response.write('{"choices":[1]}');
        await req.response.close();
      });
      final config = _config(baseUrl: 'http://127.0.0.1:${server.port}/p1');
      final own = LlmRouter(config, {'p1': 'k'}, rng: () => 0);
      await own.route('chat', _req);
      own.close();
      final err = await own.route('chat', _req).then<Object?>((r) => r, onError: (Object e) => e);
      expect((err as RouterError).attempts.single.outcome, Outcome.networkError);

      final injected = HttpTransport();
      final r1 = LlmRouter(config, {'p1': 'k'}, transport: injected, rng: () => 0);
      r1.close(); // 주입한 transport 는 그대로
      final r2 = LlmRouter(config, {'p1': 'k'}, transport: injected, rng: () => 0);
      expect((await r2.route('chat', _req)).deploymentId, 'a');
      injected.close();
      await server.close(force: true);
    });
  });
}
