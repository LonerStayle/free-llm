# free_llm_router (Dart / Flutter)

앱 안에서 무료 LLM 제공처(OpenAI 호환 `chat/completions`)를 직접 부르고, 막히면 다음 모델로 넘어가는 폴백 라우터.
Flutter SDK 에 의존하지 않는 순수 Dart 패키지다(Flutter 앱·Dart CLI 모두 사용 가능). 동작 명세는 [`../spec/SPEC.md`](../spec/SPEC.md).

## 설치

```yaml
# 앱의 pubspec.yaml
dependencies:
  free_llm_router:
    path: ../free-llm-router/flutter   # 또는 git 의존성
```

의존성은 `package:http`(1.5+) 하나. 기본 transport 는 `package:http` 의 `IOClient`(dart:io)이며,
요청마다 `followRedirects = false`, 자체 타임아웃·재시도 없음, 취소 시 소켓까지 끊는다(SPEC 3.6).

## 앱에서 쓰기

키는 소스에 쓰지 않고 `--dart-define` 으로 넣는다(HANDOFF 6절). 빌드 결과물에서는 추출 가능하므로 본인 전용 앱에서만 쓴다.

```bash
flutter run --dart-define=OPENROUTER_API_KEY=sk-or-...
# 또는 git 에서 뺀 파일로: flutter run --dart-define-from-file=keys.json
```

모델 목록은 `spec/models.json` 을 앱 assets 로 복사하거나(원격 JSON 으로 받아도 된다) `parseConfig` 로 읽는다.

```dart
import 'package:flutter/services.dart' show rootBundle;
import 'package:free_llm_router/free_llm_router.dart';

const openRouterKey = String.fromEnvironment('OPENROUTER_API_KEY');

Future<LlmRouter> createRouter() async {
  final config = parseConfig(await rootBundle.loadString('assets/models.json')); // 잘못되면 ConfigError
  return LlmRouter(config, {'openrouter': openRouterKey});
}

Future<String> ask(LlmRouter router, String text, {CancelToken? cancel}) async {
  try {
    final r = await router.route('chat', {
      'messages': [{'role': 'user', 'content': text}],
      'max_tokens': 512,
    }, cancelToken: cancel);
    // r.deploymentId: 응답한 배포, r.group: 응답한 그룹(폴백되면 다름), r.attempts: 모든 시도
    return (r.response['choices'] as List).first['message']['content'] as String;
  } on RouterError catch (e) {
    // e.kind.value: invalid_request | non_retryable | context_window_exceeded | all_failed
    // e.status·e.body 는 non_retryable 일 때만
    rethrow;
  }
  // 취소하면 RouteCancelledException (RouterError 아님)
}
```

생성자 옵션: `LlmRouter(config, keys, transport: ..., rng: ..., now: ...)`. `now` 기본값은 벽시계
`DateTime.now().millisecondsSinceEpoch`(절전 시간 포함, SPEC 1.2).
클래스 이름이 `Router` 가 아니라 `LlmRouter` 인 것은 Flutter 의 `Router` 위젯과 겹치지 않게 하려는 것이다.

`transport` 를 안 주면 라우터마다 `HttpTransport` 를 하나 만든다. 앱에서는 신경 쓸 필요 없지만,
Dart CLI 에서는 끝날 때 `router.close()` 를 부른다(안 부르면 keep-alive 소켓 때문에 프로세스가 약 15초 늦게 끝난다).
직접 넘긴 transport 는 `close()` 가 닫지 않는다.

### 취소

```dart
final cancel = CancelToken();
final future = ask(router, '안녕', cancel: cancel);
cancel.cancel();   // 진행 중인 HTTP 요청을 끊고 future 는 RouteCancelledException 으로 끝난다
```

취소된 시도는 `attempts` 에도 실패 기록에도 남지 않는다. 한 토큰을 여러 `route` 에 같이 써도 된다.

### 백그라운드와 오프라인 (SPEC 1.4)

앱이 백그라운드로 가면 진행 중인 요청을 취소하고, 연결이 돌아오면 `resetState()` 로 오프라인 동안 쌓인 실패·쿨다운을 비운다.

```dart
import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/widgets.dart';
import 'package:free_llm_router/free_llm_router.dart';

class RouterLifecycle {
  RouterLifecycle(this.router) {
    _listener = AppLifecycleListener(onHide: () {
      _token.cancel();          // 진행 중 route 전부 취소 (실패 기록 없음)
      _token = CancelToken();   // 다음 요청용 새 토큰
    });
    // connectivity_plus 사용 예
    _sub = Connectivity().onConnectivityChanged.listen((r) {
      if (!r.contains(ConnectivityResult.none)) router.resetState();
    });
  }

  final LlmRouter router;
  CancelToken _token = CancelToken();
  CancelToken get token => _token;
  late final AppLifecycleListener _listener;
  late final StreamSubscription<List<ConnectivityResult>> _sub;

  void dispose() {
    _listener.dispose();
    _sub.cancel();
  }
}
```

오프라인임을 알면 `route` 를 부르지 않는 편이 낫다(부르면 `network_error` 가 쌓여 쿨다운에 들어간다).

## 테스트

```bash
cd flutter
dart pub get
dart analyze                       # 경고 0
dart test                          # 단위 + 적합성(메모리 41 cases 중 slow 1 SKIP, configCases 42, models.json)
                                   # + 적합성 HTTP(모의 서버를 node 로 자동 기동, slow 1 SKIP)
FLR_SLOW=1 dart test test/conformance_http_test.dart   # slow 케이스(약 16초) 포함
dart run tool/run_conformance.dart [--mode memory|http|both] [--case 이름] [--slow]   # 참조 러너와 같은 표
OPENROUTER_API_KEY=... dart test --tags live            # 실제 제공처 스모크 (flutter test --tags live 도 같음)
```

- `spec/` 파일은 복사하지 않고 `FLR_SPEC_DIR`(없으면 `../spec`)에서 읽는다.
- 모의 서버: `FLR_MOCK_URL` 이 있으면 그 서버, 없으면 `node spec/mock-server/server.mjs --port 0 --exit-on-stdin-close` 를 직접 띄운다. 둘 다 안 되면 HTTP 케이스는 눈에 띄게 SKIP.
- live 스모크는 `OPENROUTER_API_KEY` 가 있을 때만 돌고, 없으면 `LIVE SKIP OPENROUTER_API_KEY not set` 을 찍고 skip 된다.
  키는 환경변수에서만 읽는다. 키를 export 해 둔 셸에서 일반 테스트만 돌리려면 `dart test -x live`.

### 기기 integration_test 에서 적합성 돌리기

러너 코어는 `package:free_llm_router/testing.dart`(메인 API 와 분리)에 있고 파일 경로 대신 JSON 문자열을 받는다.
`spec/test-cases.json` 을 테스트 앱 assets 로 복사하고(SPEC 8.2 예외), 모의 서버 URL 은 `--dart-define` 으로 넘긴다.

```dart
import 'package:free_llm_router/testing.dart';

final report = await runConformance(
  testCasesJson: await rootBundle.loadString('assets/test-cases.json'),
  modes: ['memory', 'http'],
  mockUrl: const String.fromEnvironment('FLR_MOCK_URL'), // 에뮬레이터: http://10.0.2.2:PORT
);
print(report.format());
expect(report.allPassed, isTrue);
```

Android 는 테스트 빌드에서만 cleartext http 를 허용해야 한다(`usesCleartextTraffic` / `network_security_config`).
