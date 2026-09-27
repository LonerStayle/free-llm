# 모의 제공처 서버

의존성 없는 Node(ESM, Node 18+) HTTP 서버. OpenAI 호환 `chat/completions` 제공처인 척하며, 시나리오대로 응답한다.
플랫폼 e2e 테스트(SPEC.md 8.2)와 참조 러너가 쓴다.

```bash
node spec/mock-server/server.mjs --port 0            # 빈 포트 자동 선택
# stdout 첫 줄: {"port":53817,"url":"http://127.0.0.1:53817"}
```

| 옵션 | 기본 | 뜻 |
|---|---|---|
| `--port <n>` | 0 | 0 이면 빈 포트 |
| `--host <addr>` | `127.0.0.1` | 바인딩 주소. `0.0.0.0`·`::` 이어도 출력 `url` 은 `http://127.0.0.1:PORT` |
| `--exit-on-stdin-close` | 꺼짐 | stdin 이 닫히면 종료. 테스트가 stdin 을 파이프로 연결해 띄우면, 테스트 프로세스가 강제 종료돼도 서버가 고아로 남지 않는다 |

SIGTERM/SIGINT 로 종료한다.

## 주소

- **출력된 `url` 을 그대로 쓴다.** 기본 바인딩은 IPv4 `127.0.0.1` 뿐이라 `localhost`(`::1` 로 먼저 풀리는 클라이언트)·`[::1]` 은 연결이 거부된다.
- Android 에뮬레이터: `url` 의 호스트만 `10.0.2.2` 로 바꾼다. 10.0.2.2 는 호스트의 127.0.0.1 로 연결되므로 `--host 0.0.0.0` 은 필요 없다.
- Android 실기기: `adb reverse tcp:PORT tcp:PORT` 후 `http://127.0.0.1:PORT`. 또는 `--host 0.0.0.0` 으로 띄우고 맥의 LAN 주소를 쓴다.
- Android 는 평문 http 를 허용해야 한다(테스트 전용 `network_security_config`·`usesCleartextTraffic`). 계측 테스트에는 환경변수가 전달되지 않으므로 URL 은 instrumentation argument 로 넘긴다(예: `-e flrMockUrl http://10.0.2.2:PORT`).
- keep-alive 유휴 시간은 120초다(Node 기본 5초는 다른 클라이언트의 연결 풀보다 짧아 막 닫힌 연결을 재사용하는 경합이 생긴다).

## 제공처 경로

`POST /{providerId}/chat/completions` — 테스트 설정의 `baseUrl` 을 `http://127.0.0.1:PORT/{providerId}` 로 둔다.
요청 본문의 `model` 로 스크립트를 찾아 **순서대로** 한 항목씩 응답한다. 스크립트가 없거나 다 쓰면 기본 200:

```json
{"id":"mock-<n>","object":"chat.completion","created":0,"model":"<model>",
 "choices":[{"index":0,"message":{"role":"assistant","content":"ok:<model>"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}
```

스크립트 항목:

| 필드 | 기본 | 뜻 |
|---|---|---|
| `status` | 200 | HTTP 상태 (200~599 정수) |
| `body` | 아래 | 문자열이면 원문 그대로, 객체·배열이면 JSON. 생략 시 2xx → 기본 완성, 그 외 → `{"error":{"message":"mock status <s>","code":<s>}}` |
| `headers` | `content-type: application/json` | 추가 응답 헤더 (값은 CR/LF 없는 문자열) |
| `delayMs` | 0 | 헤더를 보내기 전 대기(ms). 클라이언트가 먼저 끊으면 응답하지 않는다 |
| `bodyDelayMs` | 0 | 헤더와 본문 앞 절반을 보낸 뒤, 나머지 전 대기(ms). 타임아웃이 본문 수신까지 재는지 확인용 |
| `action` | - | `"close"` → 응답 없이 소켓을 끊는다(네트워크 오류 재현) |

## 제어 경로

| 경로 | 동작 |
|---|---|
| `POST /__scenario` | 본문 `{"responses": {"<model>": [항목, ...]}}` 을 불러오고 소비 카운터·요청 로그를 비운다. 형식이 틀리면 400 과 이유(`{"error":{"message":...}}`), 기존 시나리오는 그대로 |
| `GET /__log` | `{"requests":[{"method","path","headers"(이름 소문자),"body"(JSON 이면 파싱, 아니면 문자열)}]}` — 받은 순서 |
| `POST /__reset` | 시나리오·로그 모두 비움 |

그 밖의 경로는 404. 요청은 도착 즉시 로그에 남는다(타임아웃·취소·끊김 항목도 남는다).
처리 중 예외가 나도 서버는 죽지 않는다. 500 JSON 으로 응답하고 stderr 에 남긴다.

## 다른 스크립트에서 쓰기

`import { ScriptBook, materialize, defaultCompletion, validateResponses, createMockServer } from './server.mjs'` — import 하면 서버는 뜨지 않는다.
참조 러너의 메모리 transport 가 `ScriptBook`·`validateResponses` 를 그대로 써서 두 모드의 응답이 같다.
