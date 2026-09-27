# 라이브 스모크 테스트 규약

실제 제공처(OpenRouter)를 부르는 최소 확인. 네 플랫폼이 **같은 방식**으로 구현하고, 사용자가 직접 실행한다.
자동화(에이전트·CI)는 키 파일을 읽지 않으며 이 테스트를 돌리지 않는다.

## 실행 조건
- 환경변수 `OPENROUTER_API_KEY` 가 비어 있지 않을 때만 실행. 없으면 `LIVE SKIP OPENROUTER_API_KEY not set` 을 출력하고 **통과(skip)** 로 끝낸다.
- 키는 환경변수에서만 읽는다. `.env`·`local.properties` 등 파일을 읽지 않는다. 키와 `Authorization` 헤더는 어떤 로그에도 찍지 않는다.
- 일반 테스트 실행에 섞이지 않게 분리한다(태그·별도 타깃·환경변수 조건).

## 절차
1. `spec/models.json` 을 읽는다(복사본 금지). **`settings.timeoutSeconds` 만 20 으로 바꾼 뒤** `parseConfig` 한다(JSON 객체를 고치거나, 파싱한 Config 를 복사하며 바꾼다). 나머지 설정은 그대로.
2. `Router(config, keys = { "openrouter": <환경변수> })` — 실제 transport(3.6 설정 그대로), 실제 시계, 실제 난수.
3. 그룹 `fast`, `chat` 순서로 한 번씩 `route` 호출. 요청:
   ```json
   {"messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":256}
   ```
4. 결과마다 한 줄 출력:
   ```
   LIVE <group> ok deployment=<id> served_group=<group> ms=<총 시간> attempts=[<id>:<outcome>[:<status>]:<ms>ms,...] content="<앞 80자>"
   LIVE <group> FAIL kind=<ErrorKind> status=<status> ms=<총 시간> attempts=[...]
   ```

## 통과 기준
- 두 호출 모두 `route` 가 성공(RouteResult 반환). `choices` 가 비지 않은 것은 라우터가 이미 보장한다.
- 내용이 정확히 `pong` 인지는 **보지 않는다**(무료 모델 품질 편차). 내용이 비어 있어도(추론 모델이 토큰을 다 쓴 경우) 실패로 보지 않는다.
- 두 호출을 합쳐 **5분 안에** 끝나야 한다. 테스트가 5분 타이머를 걸고, 넘기면 진행 중인 `route` 를 취소한 뒤 `LIVE TIMEOUT total>300s` 를 출력하고 **실패**로 끝낸다.
  - 근거: 호출 하나의 최악 시간 ≈ (그 호출이 거칠 수 있는 활성 배포 수) × `timeoutSeconds`. OpenRouter 키 하나로 켜지는 배포는 chat 4개, fast 2개다. 폴백까지 치면 호출당 최대 6회 × 20초 = 120초, 두 호출 240초로 5분 안에 든다. `timeoutSeconds` 60 그대로면 최악 12분이라 이 기준을 쓸 수 없다.
- 실패 시 `attempts` 를 보고 판단: 전부 `retryable_status 429` 면 한도 문제(잠시 후 재실행), `404` 면 `models.json` 의 모델이 빠진 것(`gateway/scripts/check-models.sh` 로 확인), `fatal_status 401` 이면 키 문제.

## 플랫폼별 실행 (권장 이름)
| 플랫폼 | 위치 | 실행 |
|---|---|---|
| 참조(Node) | `spec/reference/live-smoke.mjs` | `OPENROUTER_API_KEY=... node spec/reference/live-smoke.mjs` |
| KMP | `kmp/` 의 `LiveSmokeTest` (jvmTest) | `OPENROUTER_API_KEY=... ./gradlew :<module>:jvmTest --tests '*LiveSmokeTest*'` |
| Swift | `swift/Tests/.../LiveSmokeTests.swift` | `OPENROUTER_API_KEY=... swift test --filter LiveSmokeTests` |
| Flutter | `flutter/test/live_smoke_test.dart` (`@Tags(['live'])`) | `OPENROUTER_API_KEY=... flutter test --tags live` |
| React Native | `react-native/__tests__/live-smoke.test.ts` | `OPENROUTER_API_KEY=... npx jest live-smoke` |

환경변수가 없을 때 각 플랫폼 테스트는 skip 으로 표시되어야 하고 실패로 세지 않는다.
