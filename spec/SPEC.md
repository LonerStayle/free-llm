# free-llm-router 명세 (v1)

본인 전용 모바일 앱이 무료 LLM 제공처를 **앱 안에서 직접** 호출하며 폴백하는 라이브러리.
`kmp/`, `swift/`, `flutter/`, `react-native/` 네 구현이 이 문서를 똑같이 따른다.
기준 구현은 `reference/router.mjs`, 기준 시나리오는 `test-cases.json`. 문서·참조 구현·시나리오가 어긋나면 **이 문서가 기준**이다.

| 파일 | 내용 |
|---|---|
| `SPEC.md` | 이 문서 |
| `models.json`, `models.schema.json` | 실제 모델 목록과 스키마 (6절) |
| `test-cases.json` | 언어 중립 적합성 시나리오 (8절) |
| `mock-server/` | 모의 제공처 HTTP 서버 (8.2) |
| `reference/` | Node 참조 구현 + 적합성 러너 + 라이브 스모크 (8.3) |
| `live-smoke.md` | 실제 제공처 스모크 테스트 규약 (8.4) |

용어: **그룹**(`chat`, `fast`) · **배포**(deployment = 제공처 + 모델 하나) · **시도**(attempt = HTTP 요청 한 번).

---

## 1. 공개 API (언어 중립)

```
Router(config: Config, keys: Map<providerId, String>, options?: {
    transport?: Transport,         // 기본: 플랫폼 HTTP 클라이언트 (3.6)
    rng?: () -> Double,            // [0,1). 기본: 플랫폼 난수
    now?: () -> Long,              // 밀리초. 기본: 1.2 의 시계
})

route(group: String, request: JsonObject, cancel?) -> RouteResult   // 실패 시 RouterError, 취소 시 취소 예외 (1.1)
deploymentStates() -> Map<deploymentId, DeploymentState>            // 진단·테스트용
resetState()                                                         // 모든 배포의 실패 기록·쿨다운을 비운다 (1.4)

parseConfig(json: String) -> Config                                  // models.json 형식. 잘못되면 ConfigError (6절)
```

```
RouteResult     { response: JsonObject, deploymentId: String, group: String, attempts: [Attempt] }
Attempt         { deploymentId, group, outcome: Outcome, status: Int?, durationMs: Long, message: String? }
RouterError     { kind: ErrorKind, status: Int?, body: String?, attempts: [Attempt], message }
DeploymentState { coolingDown: Bool, cooldownUntilMs: Long?, recentFailures: Int }
Transport       send(url, headers: Map<String,String>, body: String, cancel) -> { status: Int, text: String }
                // text = 응답 본문 원문. 응답을 못 받으면(연결 실패·끊김) 예외. 타임아웃은 라우터가 건다 (3.6).
```

- `request` 는 OpenAI `chat/completions` 본문에서 `model` 을 뺀 것. 호출자가 `model` 을 넣어도 무시(덮어씀)한다.
- `response` 는 제공처 응답 JSON 전체. `group` 은 **실제로 응답한** 그룹(폴백되면 요청 그룹과 다르다).
- `attempts` 는 이번 요청의 모든 시도, 시도한 순서대로. 성공·실패 모두 포함한다.
- `durationMs` 는 그 시도의 실제 경과 시간이다. 플랫폼 단조 시계로 재며, 주입된 `now` 와는 관계없다(테스트는 비교하지 않는다).
- `deploymentStates()` 는 설정의 **모든** 배포(비활성·키 없음 포함)를 담는다. `cooldownUntilMs` 는 `coolingDown` 일 때만 값이 있고 아니면 null. `recentFailures` 는 3.4 의 창 안 실패 수.
- 이름은 언어 관례에 맞춰도 된다(`RouterError` → Kotlin sealed class, Swift enum 등). 단 `Outcome`·`ErrorKind` 의 **문자열 값**은 아래 표 그대로 노출한다(테스트가 비교한다).
- 상태(실패 기록·쿨다운)는 **메모리에만, 라우터 인스턴스 단위**. 앱 재시작 시 초기화.
- 스트리밍은 범위 밖. `request.stream == true` 는 `invalid_request`.
- 참조 구현의 `Router` 는 설정 객체를 받아 생성자에서 `normalizeConfig` 를 부른다. `parseConfig` 결과를 넘기는 것과 같다.

### 1.1 취소

| 언어 | 취소 수단 | 취소 시 던지는 것 |
|---|---|---|
| Kotlin | `suspend fun route(...)` — 구조적 취소(코루틴 Job) | `CancellationException` |
| Swift | `func route(...) async throws` — Task 취소 | `CancellationError` |
| Dart | `route(group, request, {CancelToken? cancelToken})`. `CancelToken` 은 라이브러리가 정의: `cancel()`, `isCancelled`, `whenCancelled` | `RouteCancelledException` (라이브러리 정의) |
| TS | `route(group, request, { signal?: AbortSignal })` | `signal.reason` (기본 `DOMException` `AbortError`) |

- 취소 예외는 **`RouterError` 로 감싸지 않는다.** `ErrorKind` 도 아니다.
- 확인 시점: (1) 매 시도 직전(후보 계산·`rng()` 전), (2) 시도 중에는 transport 를 즉시 중단, (3) transport 가 끝난 직후(결과 분류 전). `invalid_request` 검사는 그보다 먼저 한다.
- 취소되면 진행 중이던 시도는 `attempts` 에도, 실패 기록에도 넣지 않는다. 그 전에 끝난 시도의 기록은 그대로 둔다.
- 흔한 함정: transport 예외를 한꺼번에 잡으면 취소까지 `network_error`(+1 실패)로 바뀐다. **transport 예외가 호출자 취소 때문이면 `network_error` 가 아니다.**
  - Kotlin: `catch (e: CancellationException) { throw e }` 를 일반 catch 앞에 둔다. OkHttp·Ktor 가 `IOException("Canceled")` 로 바꿔 던질 수 있으므로 모든 catch 뒤에 `currentCoroutineContext().ensureActive()`. 라우터 자체 타임아웃을 `withTimeout` 으로 걸면 `TimeoutCancellationException` 도 `CancellationException` 이므로 그것만 `timeout` 으로 분류한다.
  - Swift: URLSession 은 Task 취소 시 `URLError(.cancelled)` 를 던진다. catch 에서 `Task.isCancelled` 면 `CancellationError` 를 던진다. 라우터 자체 타임아웃으로 취소한 경우(Task 는 살아 있음)만 `timeout`.
  - Dart·TS: catch 에서 토큰/신호가 취소 상태인지 먼저 본다.
- 취소는 즉시 전파한다. 대기 중인 응답이나 타이머를 끝까지 기다리지 않는다.

### 1.2 시계와 난수

`now()` 기본값은 **기기 절전 시간을 포함하는 시계**다. 절전을 빼는 시계를 쓰면 화면이 꺼진 동안 쿨다운·실패 창이 멈춘다.

| 플랫폼 | 기본 `now()` |
|---|---|
| KMP Android | `SystemClock.elapsedRealtime()` |
| KMP iOS·macOS(Native) | `clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000` (Darwin 의 `CLOCK_MONOTONIC` 은 절전 포함) |
| KMP JVM(테스트용) | `System.nanoTime() / 1_000_000` |
| Swift | `ContinuousClock` 또는 `clock_gettime_nsec_np(CLOCK_MONOTONIC)`. `SuspendingClock`·`ProcessInfo.systemUptime` 은 쓰지 않는다 |
| Dart | `DateTime.now().millisecondsSinceEpoch` (벽시계 허용. `Stopwatch` 는 플랫폼에 따라 절전을 빼므로 쓰지 않는다) |
| TS(RN) | `Date.now()` (벽시계 허용) |

벽시계가 뒤로 가면 쿨다운이 그만큼 길어질 수 있다. 허용한다.
`rng()` 기본값은 플랫폼 난수다. 결과가 [0,1) 이기만 하면 된다.

### 1.3 동시 호출

- 한 라우터로 여러 `route` 를 동시에 불러도 안전해야 한다. 배포 상태 갱신(3.4 `recordFailure`)과 조회는 배포 단위로 원자적이어야 한다.
- 주입된 `rng`·`now` 는 여러 스레드·코루틴에서 동시에 불릴 수 있다.
- `rng()` 소비 순서의 결정성은 **요청 하나를 순차로 실행할 때만** 보장한다. 적합성 시나리오도 요청을 한 번에 하나씩 보낸다.
- 쿨다운 중인 배포에 늦게 도착한 실패(쿨다운 전에 시작된 동시 요청)도 3.4 그대로 기록한다. 그 실패로 다시 `allowedFails` 에 닿으면 `cooldownUntil` 이 새로 잡혀 연장된다. 쿨다운이 끝난 뒤에도 창 안에 남은 실패는 계속 센다. 의도한 동작이다(구현을 단순하고 같게 유지).

### 1.4 모바일 수명주기 (백그라운드·오프라인)

- 앱이 백그라운드로 갈 때 진행 중인 `route` 를 **취소**한다(iOS: `beginBackgroundTask` 만료 핸들러나 `scenePhase == .background`, Android: `ProcessLifecycleOwner` 의 `ON_STOP` 등). 취소는 실패 기록을 남기지 않는다(1.1). 취소하지 않은 채 OS 가 연결을 끊으면 그 시도는 `network_error` 로 기록된다.
- 오프라인에서도 규칙대로 `network_error`·`timeout` 은 실패 +1 이다. 그래서 오프라인에서 요청을 되풀이하면 배포들이 쿨다운에 들어가고, 연결이 돌아와도 최대 `cooldownSeconds` 동안 `all_failed` 가 날 수 있다. v1 은 이 위험을 받아들이되, 회복 수단으로 `resetState()` 를 둔다. 앱이 연결 복구를 감지하면(Android `ConnectivityManager.NetworkCallback.onAvailable`, iOS `NWPathMonitor` 의 `.satisfied`) `resetState()` 를 불러 실패 기록과 쿨다운을 모두 비운다. 진행 중인 `route` 에는 영향을 주지 않는다(그 뒤 기록되는 실패는 새로 쌓인다). 앱이 연결 상태를 알면 오프라인일 때는 `route` 를 부르지 않는 것도 권장한다.

## 2. 처리 흐름 (의사코드)

모든 언어가 **이 순서 그대로** 구현한다. `rng()` 호출 횟수와 시점까지 같아야 테스트가 공유된다.

```
route(group, request, cancel):
    attempts = []
    if group not in config.groups                          -> throw invalid_request
    if request.messages is not array or request.stream == true -> throw invalid_request
    tokens    = estimateTokens(request)          // 3.1
    attempted = {}                               // 이번 요청에서 시도한 deployment id (그룹 공통)
    visited   = {}; queue = [group]; reasons = []
    while queue not empty:
        g = queue.popFront(); visited.add(g)
        r = runGroup(g, ...)                     // 성공이면 RouteResult 반환, 즉시 실패면 throw
        reasons.add(r.reason)                    // "context" | "retryable"
        next = r.reason == "context" ? settings.contextWindowFallbacks[g] : settings.fallbacks[g]
        for n in (next ?? []): if n not in visited and n not in queue: queue.pushBack(n)
    kind = (모든 reasons 가 "context") ? context_window_exceeded : all_failed
    throw RouterError(kind, attempts)

runGroup(g):
    n = 0; last = null; tokenExcludedAtStart = false
    while n < 1 + settings.numRetries:
        throwIfCancelled(cancel)                 // 1.1
        (cands, tokenExcluded) = candidates(g, tokens, attempted, now())
        if cands empty:
            if n == 0: tokenExcludedAtStart = tokenExcluded
            break
        d = pickWeighted(cands, rng)             // rng 는 여기서만, 후보가 있을 때 정확히 1번
        attempted.add(d.id); n += 1
        outcome = send(d, cancel)                // 3.6, 4절. 취소되면 취소 예외가 그대로 올라간다
        attempts.add(...)
        switch outcome:
            ok               -> return RouteResult
            fatal_status     -> throw RouterError(non_retryable, status, body, attempts)
            context_exceeded -> last = "context"                     // 실패 기록 안 함
            그 외(retryable_status, bad_body, timeout, network_error)
                             -> recordFailure(d.id, now()); last = "retryable"
    reason = n > 0 ? last : (tokenExcludedAtStart ? "context" : "retryable")
    return reason

candidates(g, tokens, attempted, now):       // 설정 순서 유지
    for d in config.groups[g].deployments:
        skip if not d.enabled
        skip if keys[d.provider] 가 없거나 빈 문자열
        skip if isCoolingDown(d.id, now)
        skip if d.id in attempted
        if d.maxInputTokens != null and tokens > d.maxInputTokens: tokenExcluded = true; skip
        cands.add(d)

pickWeighted(cands, rng):
    total = Σ d.rpm;  r = rng() * total;  acc = 0     // total·r·acc 는 64비트 실수(또는 64비트 정수 + 실수 r)
    for d in cands: acc += d.rpm; if acc > r: return d
    return cands.last                           // 부동소수 방어
```

## 3. 규칙 세부

### 3.1 토큰 추정 (고정 공식)
`tokens = (units + 3) / 4` (정수 나눗셈, 즉 `ceil(units / 4)`).
`units` = `request.messages[*].content` 길이의 합. 길이 단위는 **UTF-16 코드 유닛**.
- `content` 가 문자열 → 그 길이
- `content` 가 배열 → 각 원소 중 `text` 가 문자열인 것의 길이 합 (`type` 은 보지 않음. 이미지 등은 0)
- 그 외(`null`, 없음) → 0. `role`, `name`, `tool_calls` 등은 세지 않는다

언어별: Kotlin `String.length`, Swift `s.utf16.count` (`s.count` 아님), Dart `String.length`, TS `string.length`.

### 3.2 후보와 선택
2절 `candidates`, `pickWeighted` 그대로. `rpm` 은 1 이상 정수(가중치로만 쓴다. 분당 요청 수를 실제로 제한하지는 않는다).
`total` 은 **이번에 남은 후보들만**의 합이다(이미 시도한 배포는 빠진다).
후보가 하나여도 `rng()` 를 1번 호출한다. 후보가 없으면 호출하지 않는다.

### 3.3 시도 한도
그룹마다 최대 `1 + numRetries` 회(기본 4). 컨텍스트 초과 시도도 1회로 센다. 그룹이 바뀌면 다시 센다.
같은 요청 안에서 같은 배포는 두 번 시도하지 않는다(그룹을 옮겨도).

### 3.4 실패 기록과 쿨다운
배포마다 `failures: [시각]`, `cooldownUntil: 시각?` 을 둔다. `window = round(cooldownSeconds × 1000)` ms (양수라 .5 는 올림).

```
isCoolingDown(id, now) = cooldownUntil != null and now < cooldownUntil
recordFailure(id, now):
    failures = [t in failures where now - t < window]    // 정확히 window 만큼 지난 실패는 뺀다
    failures.add(now)
    if failures.size >= allowedFails:
        cooldownUntil = now + window; failures = []
recentFailures(id, now) = count(t in failures where now - t < window)   // deploymentStates 용
```
- 쿨다운은 `now >= cooldownUntil` 이 되는 순간 끝난다(예: 60,000ms 뒤 정각에 복귀).
- 성공해도 실패 기록을 지우지 않는다.
- 실패 창과 쿨다운 길이는 둘 다 `cooldownSeconds` 다(규칙 6). 60초를 하드코딩하지 않는다.
- 쿨다운 중에 기록되는 실패는 1.3.

### 3.5 그룹 종료 사유와 그룹 폴백
- 그룹 종료 사유 = 그 그룹의 **마지막 시도** 결과가 `context_exceeded` 면 `context`, 아니면 `retryable`.
- 그룹에서 한 번도 시도하지 못했으면: 토큰 한도(`maxInputTokens`)로 빠진 배포가 **하나라도** 있으면(다른 배포가 쿨다운·키 없음·비활성으로 빠졌어도) `context`, 없으면 `retryable`.
- `retryable` → `fallbacks[g]` 의 그룹들을, `context` → `contextWindowFallbacks[g]` 의 그룹들을 대기열 뒤에 넣는다(방문했거나 이미 대기 중인 그룹은 넣지 않는다). 대기열은 FIFO 다.
- `context` 인데 `contextWindowFallbacks[g]` 가 없으면 **일반 fallbacks 로 가지 않는다**. 큰 모델이 없는 그룹으로 옮겨 봐야 다시 초과한다.
- 한 요청에서 그룹은 한 번만 방문한다(`chat → fast → chat` 금지). 앞 그룹에 시도 안 한 배포가 남아 있어도 다시 가지 않는다.
- 대기열이 비면: 방문한 모든 그룹의 사유가 `context` 면 `context_window_exceeded`, 하나라도 `retryable` 이면 `all_failed`.

### 3.6 HTTP 요청
- `POST {baseUrl 에서 끝의 / 제거}/chat/completions`
- 헤더: `Content-Type: application/json`, `Authorization: Bearer <keys[providerId]>`, 그리고 그 제공처의 `extraHeaders` 전부. `extraHeaders` 에 `Authorization`·`Content-Type` 은 둘 수 없다(설정 오류).
- 본문: `request` 의 모든 필드를 그대로 두고 `model` 만 배포의 `model` 로 설정한 JSON. 알 수 없는 필드도 버리지 않는다.
- 시도마다 `timeoutMs = round(timeoutSeconds × 1000)`(기본 60초, 소수 허용) 안에 **응답 본문까지** 다 받아야 한다. 넘기면 요청을 취소하고 `timeout`. 시간 초과 판정은 **라우터 타이머만** 한다.
- **한 시도 = 정확히 한 번의 HTTP 요청.** transport 는 스스로 재시도하지 않고, 리다이렉트를 따라가지 않는다(3xx 는 그대로 받아 4절에서 `fatal_status`). `Retry-After` 헤더는 보지 않는다.
- 기본 transport 는 플랫폼 클라이언트의 자체 타임아웃을 끄거나 `timeoutSeconds + 5초` 이상으로 둔다. 안 그러면 느린 응답이 플랫폼마다 `network_error` 가 되기도 하고 성공하기도 한다.

| 플랫폼 | 기본 transport 설정 |
|---|---|
| OkHttp | `retryOnConnectionFailure(false)`, `followRedirects(false)`, `followSslRedirects(false)`, connect·read·write·call 타임아웃 0(끔) 또는 `timeoutSeconds+5` 이상 |
| Ktor | `HttpRequestRetry` 설치 안 함, `followRedirects = false`, `HttpTimeout` 은 설치 안 하거나 `timeoutSeconds+5` 이상, CIO 엔진이면 `requestTimeout = 0` |
| URLSession | `timeoutIntervalForRequest`·`timeoutIntervalForResource` ≥ `timeoutSeconds+5`, 리다이렉트는 delegate `willPerformHTTPRedirection` 에서 `nil` 로 거부 |
| Dart `package:http` | 요청마다 `followRedirects = false`. 기본 타임아웃은 없다 |
| RN `fetch` | 타임아웃 없음. 기기 런타임의 `fetch` 는 리다이렉트를 끌 수 없다(아래 예외) |

예외: RN 기기 런타임만 3xx 를 따라간다. 실제 제공처는 리다이렉트를 쓰지 않으므로 실사용 차이는 없다. RN 의 적합성·e2e 는 Node(Jest) 의 `fetch` 에 `redirect: "manual"` 을 주는 transport 로 돌려 이 규칙을 검증한다.

## 4. 시도 결과(Outcome) 분류

위에서부터 처음 맞는 것. `text` = 응답 본문 원문.

| Outcome | 조건 | 실패 기록 | 다음 동작 |
|---|---|---|---|
| `ok` | 2xx, 본문이 JSON 객체, `error` 가 없거나 null, `choices` 가 비지 않은 배열 | - | 성공 반환 |
| `bad_body` | 2xx 인데 위 조건 불만족 (JSON 아님·객체 아님(배열 포함), `error` 가 null 아닌 값, `choices` 없음·배열 아님·빈 배열) | +1 | 다음 후보 |
| `context_exceeded` | 400 또는 413 이고, `asciiLower(text)` 에 `context length` · `context_length` · `maximum context` · `too many tokens` 중 하나 포함 | 없음 | 다음 후보 |
| `retryable_status` | 404, 408, 429, 500~599 | +1 | 다음 후보 |
| `fatal_status` | 그 밖의 모든 상태 (400, 401, 403, 413, 422 등 4xx, 1xx, 3xx) | 없음 | **즉시 실패** (`non_retryable`) |
| `timeout` | 3.6 의 시간 초과 (`status` = null) | +1 | 다음 후보 |
| `network_error` | 응답을 못 받음: 연결 실패·끊김·DNS 등 (`status` = null). 호출자 취소는 제외(1.1) | +1 | 다음 후보 |

- `asciiLower` = ASCII `A–Z` 만 `a–z` 로 바꾸고 나머지 문자는 그대로 둔다. **로캘·유니코드 소문자화를 쓰지 않는다.** Kotlin `toLowerCase()` 는 터키어 로캘에서 `I` 를 `ı` 로 바꾸고, 유니코드 소문자화는 켈빈 기호 `K`(U+212A)를 `k` 로 바꾼다. 둘 다 이 규칙과 다르다. 구현 예: 코드 유닛마다 `'A'..'Z'` 이면 +32.
- `error.code == "context_length_exceeded"` 는 `context_length` 를 포함하므로 위 문자열 검사에 들어 있다. 본문 **전체**를 보는 이유: OpenRouter 는 제공처 오류를 `error.metadata.raw` 에 싸서 준다.
- `Attempt.status` 는 HTTP 응답을 받았으면 그 상태 코드, `timeout`·`network_error` 면 null.
- 취소는 Outcome 이 아니다(1.1).

## 5. 최종 에러(ErrorKind)

| ErrorKind | 언제 | `status` | `body` | `attempts` |
|---|---|---|---|---|
| `invalid_request` | 없는 그룹, `messages` 가 배열 아님, `stream: true` | null | null | 빈 목록 |
| `non_retryable` | 어느 시도든 `fatal_status` | 그 상태 코드 | 응답 본문 원문 | 그때까지의 시도 (마지막이 fatal) |
| `context_window_exceeded` | 대기열 소진, 방문 그룹 전부 `context` 사유 | null | null | 전부 |
| `all_failed` | 대기열 소진, 그 외 (시도 0회 포함) | null | null | 전부 |

호출자 취소는 `RouterError` 가 아니라 언어 네이티브 취소 예외다(1.1). 설정 자체가 잘못되면 `parseConfig` 에서 `ConfigError`(라우팅 에러 아님).

## 6. 설정 형식 (`models.json`)

스키마: `models.schema.json`. 키 값은 **절대 넣지 않는다**. 앱이 런타임에 `providerId → key` 맵으로 넘긴다.

```jsonc
{
  "version": 1,
  "providers": [
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1",
      "keyName": "OPENROUTER_API_KEY",            // 앱이 키를 찾을 때 쓰는 이름 (BuildConfig·dart-define 등). 라우터는 안 씀
      "extraHeaders": { "X-Title": "free-llm-router" } }
  ],
  "groups": {
    "chat": { "deployments": [
      { "id": "chat-qwen3.8-27b",                  // 설정 전체에서 유일. 쿨다운 상태의 키
        "provider": "openrouter",
        "model": "qwen/qwen3.8-27b:free",          // 제공처에 그대로 보낼 이름 (LiteLLM 접두어 없음)
        "rpm": 4,                                  // 가중치, 1 이상 정수
        "maxInputTokens": 6000,                    // 선택. 3.1 추정치가 이보다 크면 후보 제외
        "enabled": true,                           // 선택, 기본 true
        "note": "메모" }                           // 선택, 라우터는 안 씀
    ] },
    "fast": { "deployments": [ ... ] }
  },
  "settings": {                                    // 전부 선택, 아래가 기본값
    "numRetries": 3, "allowedFails": 3, "cooldownSeconds": 60, "timeoutSeconds": 60,
    "fallbacks": {},                               // models.json 은 { "chat": ["fast"], "fast": ["chat"] }
    "contextWindowFallbacks": {}                   // models.json 은 { "fast": ["chat"] }
  }
}
```

**`parseConfig` 규칙** (`test-cases.json` 의 `configCases` 가 검증한다)
- **모르는 키는 모든 레벨에서 무시한다**(`$schema`, `description`, `updated`, 그룹의 `description`, 앞으로 생길 `tpm` 등). `note` 는 타입과 관계없이 무시한다. 원격 JSON 에 필드가 늘어도 깨지지 않게 하기 위해서다. `models.schema.json` 은 저장소 파일 검증용이라 모르는 키를 거부할 만큼 더 엄격하다.
- **선택 필드가 null** 이면 없는 것(기본값)으로 본다. **필수 필드가 null** 이면 거부한다.
- **정수** = JSON 수 중 소수부가 0 인 것이다. `4`, `4.0` 모두 4 로 받는다(Dart `jsonDecode` 는 `4.0` 을 double 로 준다). `4.5`, 문자열 `"4"`, 불리언은 거부한다. 범위는 최대 2147483647.
- **수**(`cooldownSeconds`·`timeoutSeconds`) = JSON 수. 문자열은 거부한다.

거부(`ConfigError`)하는 것:
- JSON 문법 오류, 최상위가 객체가 아님, `version` 이 있는데 1 이 아님
- `providers` 가 배열이 아님. 원소가 객체가 아님. `id`·`baseUrl` 이 비었거나 문자열이 아님. `keyName` 이 문자열이 아님. `extraHeaders` 가 객체가 아니거나, 값이 문자열이 아니거나, 이름이 `Authorization`·`Content-Type`(대소문자 무시)임. 제공처 id 중복
- `groups` 가 객체가 아님. 그룹이 객체가 아니거나 `deployments` 가 배열이 아님
- 배포: 객체가 아님, `id`·`model` 이 비었거나 문자열이 아님, id 중복(그룹 간 포함), `provider` 가 없거나 없는 제공처, `rpm` 이 1 이상 정수가 아님, `maxInputTokens` 가 1 이상 정수가 아님, `enabled` 가 불리언이 아님
- `settings` 가 객체가 아님. `numRetries` 가 0 이상 정수가 아님. `allowedFails` 가 1 이상 정수가 아님. `cooldownSeconds`·`timeoutSeconds` 가 0 보다 큰 수가 아님. `fallbacks`·`contextWindowFallbacks` 가 객체가 아니거나, 키나 값에 없는 그룹이 있거나, 값이 문자열 배열이 아님

배포가 없는 그룹, 빈 `providers` 는 허용한다(그 그룹은 시도 0회로 끝난다).

제공처 메모: Gemini 는 OpenAI 호환 `https://generativelanguage.googleapis.com/v1beta/openai`, 모델명에 `models/` 접두어 없음. Gemini 무료분과 Mistral 기본값은 **입력을 학습에 사용**하므로 `models.json` 에서 `enabled: false`. Gemini·Groq 의 입력 초과·TPM 초과 오류 문구는 확인하지 않았다. 켜기 전에 live 로 문구를 확인한다. 4절 패턴에 맞지 않으면 `fatal_status` 가 되기 때문이다.
원격 JSON 으로 목록을 받아 쓰는 것은 앱의 선택이다(같은 `parseConfig` 사용).

## 7. 선택 기능: OpenRouter `models` 배열 (구현 필수 아님)

OpenRouter 는 요청 본문에 `"models": ["a", "b", ...]` 를 넣으면 서버 쪽에서 폴백한다(사유: 컨텍스트 초과·모더레이션·레이트리밋·다운타임). 응답의 `model` 이 실제 쓰인 모델이고 과금도 그 기준이다. 최대 개수는 문서에 없다.
구현한다면 옵션으로만 두고(기본 꺼짐) 켜져 있어도 이 명세의 선택·쿨다운·폴백 규칙은 그대로 적용한다. 적합성 시나리오는 이 기능을 다루지 않는다.

## 8. 테스트

각 플랫폼은 아래 세 가지를 갖춘다. 8.1·8.2 는 CI/로컬에서 항상, 8.4 는 사용자가 직접.

### 8.1 적합성 — 메모리 transport
`test-cases.json` 의 **모든 케이스**와 **모든 `configCases`** 를 돌린다. 파일은 복사하지 말고 `spec/` 에서 읽는다(경로는 `FLR_SPEC_DIR` 환경변수, 없으면 저장소 상대 경로 `../spec`). 예외는 8.2 의 에뮬레이터 계측 테스트뿐이다.

케이스 형식:
```jsonc
{ "name", "description",
  "tags":      ["slow"],             // 선택. 8.2 참고
  "config":    { ... },              // 6절 형식. 문자열 안의 "{{MOCK_BASE}}" 를 치환해서 쓴다
  "keys":      { "p1": "key-p1" },   // Router 에 그대로 넘김
  "rng":       [0, 0.5, ...],        // rng() 가 순서대로 돌려줄 값
  "responses": { "m-a": [ {"status":429, "body":{...}}, ... ] },   // body.model 별 응답 스크립트
  "steps": [
    { "op": "request", "group": "chat", "request": {...}, "expect": {...} },
    { "op": "request", "group": "chat", "request": {...}, "cancelAfterMs": 200, "expect": { "cancelled": true, "requests": [...] } },
    { "op": "advance", "ms": 60000 },
    { "op": "reset" },                       // resetState() 호출
    { "op": "expectState", "states": { "a": { "coolingDown": true, "cooldownUntilMs": 1060000, "recentFailures": 0 } } }
  ] }
```
- 시계: 케이스마다 `clockStartMs`(파일 최상위, 1,000,000)에서 시작, `advance` 로만 움직인다. 요청 중에는 멈춰 있다.
- rng: 값이 모자라면 케이스 실패. 끝났을 때 **모든 값을 다 써야** 통과.
- 응답 스크립트 항목 `{ status?=200, body?, headers?, delayMs?=0, bodyDelayMs?=0, action? }`: `body` 가 문자열이면 원문 그대로, 객체면 JSON. 생략 시 2xx 는 기본 완성 응답(`choices[0].message.content == "ok:<model>"`), 그 외는 `{"error":{"message":"mock status <s>","code":<s>}}`. `delayMs` 는 헤더 전 대기, `bodyDelayMs` 는 헤더와 본문 절반을 보낸 뒤 나머지 전 대기. `action: "close"` 는 응답 없이 연결 끊기 → 가짜 transport 는 예외를 던진다. 스크립트가 다 떨어진 모델·스크립트가 없는 모델은 기본 200. 소비 카운터는 케이스 전체에서 이어진다.
- `delayMs`·`bodyDelayMs` 는 가짜 transport 도 **실제로 기다린다**(합계만큼, 취소 가능하게). 그래야 라우터의 타임아웃·취소 경로가 실제로 돈다. 타임아웃 케이스는 0.3초라 빠르다.
- 가짜 transport 의 요청 로그: `{ path: URL 경로, headers: 이름 소문자, body: 파싱한 JSON }`.
- 메모리 모드의 `{{MOCK_BASE}}` 는 `http://mock.invalid`.

`expect` 비교(요청 단계):
- 성공: `ok: true`, `deployment`, `group` 일치. `content` 가 있으면 `response.choices[0].message.content` 일치.
- 실패: `ok: false`, `error.kind` 일치, `error.status` 일치(null 포함). `error.bodyContains` 가 있으면 `error.body` 가 그 문자열을 포함. `non_retryable` 이 아니면 `error.body` 는 null.
- 항상: `attempts` 를 `[{deployment, group, outcome, status}]` 로 바꿔 **순서까지 정확히** 일치.
- 항상(불변식): 이 단계에서 제공처가 받은 요청 수 == 시도 수, i 번째 요청의 경로 == 그 배포 제공처의 `/…/chat/completions`, `body.model` == 그 배포의 `model`.
- `requests` 가 있으면: 개수 일치, 각 항목 `path` 일치, `headers` 는 부분 일치(이름 소문자, 값 정확히), `absentHeaders` 는 없어야 함, `body` 는 JSON 으로 깊은 비교(키 순서 무시, 숫자는 값 비교).

취소 단계(`cancelAfterMs` 가 있는 요청 단계):
- `cancelAfterMs == 0` 이면 이미 취소된 상태로 `route` 를 부른다(Kotlin: 코루틴 안에서 `cancel()` 뒤 호출, Swift: 취소된 Task 안에서 호출, Dart: `cancel()` 한 토큰, TS: `abort()` 한 signal). 0 보다 크면 호출하고 그 ms 뒤에 취소한다.
- 기대: 1.1 의 언어 네이티브 취소 예외(`RouterError` 아님), 취소 뒤 500ms 안에 끝남, 제공처가 받은 요청 수와 각 `path` 가 `requests` 와 일치. 이 단계는 시도 수 불변식을 보지 않는다(진행 중이던 시도는 `attempts` 에 없다).

`expectState`: `deploymentStates()` 에서 적힌 필드만 비교(`cooldownUntilMs: null` 은 쿨다운 아님).

`configCases`: `{ name, description, json, expect: "ok" | "config_error" }`. `parseConfig(json)` 이 성공하면 `ok`, `ConfigError` 면 `config_error`. 다른 예외는 실패. `json` 은 원문 문자열이다(`4.0` 같은 표기를 그대로 넘기기 위해).

### 8.2 e2e — 모의 서버 경유 실제 HTTP
같은 케이스를 **플랫폼의 실제 기본 transport**(3.6 설정 그대로: OkHttp/Ktor, URLSession, `package:http`, `fetch`)로 모의 서버에 보낸다.
1. 서버 준비: 환경변수 `FLR_MOCK_URL` 이 있으면 그 서버를 쓴다. 없으면 테스트가 `node <spec>/mock-server/server.mjs --port 0 --exit-on-stdin-close` 를 stdin 파이프와 함께 직접 띄우고 stdout 첫 줄 JSON 의 `url` 을 쓴다(테스트 프로세스가 죽으면 서버도 끝난다). 둘 다 불가하면 **SKIP 을 눈에 띄게 출력**한다(조용히 통과 금지).
2. 케이스마다 `POST /__scenario {"responses": case.responses}` (로그도 비워진다). 200 이 아니면 그 케이스 실패.
3. `{{MOCK_BASE}}` 를 서버 URL 로 치환 (예: `http://127.0.0.1:53817/p1`). 출력된 `url` 을 그대로 쓴다. `localhost` 로 바꾸지 않는다(서버는 IPv4 `127.0.0.1` 에만 바인딩한다).
4. 요청 단계마다 `GET /__log` 에서 새로 늘어난 항목을 8.1 과 똑같이 검사.
5. 모의 서버는 공유 상태이므로 케이스는 **순서대로** 돌린다.
- `action: "close"` 케이스(`retry_network_error`)는 transport 가 스스로 재시도하지 않는지(3.6), 302 케이스(`fatal_other_4xx`)는 리다이렉트를 따라가지 않는지, `timeout_during_body` 는 타임아웃이 본문까지 재는지 확인한다.
- `tags` 에 `slow` 가 있는 케이스(`slow_response_within_timeout`, 약 16초)는 플랫폼 HTTP 클라이언트 자체 타임아웃을 잡는다. http 모드에서만 의미가 있다. 기본 실행에서 빼도 되지만 그때는 SKIP 으로 표시한다. transport 설정을 바꾸면 반드시 돌린다.
- **필수 e2e 는 호스트에서 돈다**: KMP `jvmTest`(+ macOS 타깃), Swift `swift test`(macOS), Flutter `flutter test`(VM), RN Jest(Node). iOS 는 macOS 타깃으로 대체한다(HANDOFF 2절).
- Android 에뮬레이터·실기기 계측 테스트는 **선택**이다. 할 때만 다음을 허용·요구한다.
  - 빌드 단계에서 `spec/test-cases.json` 을 androidTest assets 로 복사해도 된다(기기는 호스트 파일을 못 읽는다).
  - 서버 URL 은 instrumentation argument 로 넘긴다(환경변수는 기기에 전달되지 않는다). 예: `-e flrMockUrl http://10.0.2.2:53817`.
  - 에뮬레이터는 출력된 `url` 의 호스트만 `10.0.2.2` 로 바꾼다. 10.0.2.2 는 호스트의 127.0.0.1 로 연결되므로 서버를 `0.0.0.0` 에 바인딩할 필요가 없다.
  - 실기기는 `adb reverse tcp:PORT tcp:PORT` 후 `127.0.0.1` 을 쓰거나, 서버를 `--host 0.0.0.0` 으로 띄우고 맥의 LAN 주소를 쓴다.
  - 평문 http 이므로 테스트 전용 매니페스트·`network_security_config` 에서 cleartext 를 허용한다(릴리스 빌드에는 넣지 않는다).

### 8.3 참조 러너
```
node spec/reference/run-conformance.mjs                # memory + http, 표 출력, 실패 시 exit 1
node spec/reference/run-conformance.mjs --mode memory  # 또는 --mode http, --case <name>, --slow
```
참조 구현이 모든 케이스를 두 모드로 통과한다 = 시나리오가 자기모순 없이 만족 가능하다는 증거. 시나리오를 고치면 반드시 이 러너부터 통과시킨다. 러너는 `models.json` 도 스키마·`normalizeConfig` 로 검사하고, `configCases` 도 돌린다.
- `slow` 케이스: memory 모드는 항상 SKIP, http 모드는 `--slow` 또는 `--case` 로 지정할 때만 돈다.
- 알 수 없는 `--mode` 는 exit 2, `--case` 에 맞는 케이스가 없으면 exit 1.
플랫폼 러너도 같은 표(케이스 × 모드, PASS/FAIL/SKIP)를 출력하길 권장한다.

### 8.4 라이브 스모크
`live-smoke.md`. `OPENROUTER_API_KEY` 환경변수가 있을 때만 실제 호출.

## 9. HANDOFF 4절 대비 다듬은 점

| 항목 | 이 명세 | 이유 |
|---|---|---|
| 5xx | 500~599 전부 재시도 (HANDOFF: 500~504) | Cloudflare 520~524 등도 일시 장애. 재시도해도 손해 없음 |
| 컨텍스트 초과 문구 | 본문 전체 문자열에서 ASCII 소문자로 검사 | OpenRouter 는 `error.metadata.raw` 에 원래 메시지를 넣는다. 로캘에 따라 결과가 달라지면 안 된다 |
| 컨텍스트 사유인데 contextWindowFallbacks 없음 | 일반 fallbacks 로 가지 않고 `context_window_exceeded` | 작은 모델 그룹으로 옮겨 봐야 또 초과 |
| 그룹 폴백 순회 | 대기열(FIFO, 방문 그룹 제외) | `fallbacks` 목록이 여러 개여도 빠짐없이, 무한 루프 없이 |
| 404 | 재시도 | 무료 모델이 목록에서 빠질 때 404 |
| 3xx | 따라가지 않고 즉시 실패 | 플랫폼마다 POST 리다이렉트 처리(메서드 변환)가 달라 결과가 갈린다 |

LiteLLM 과의 대응(`allowed_fails` 경계, 429 즉시 쿨다운 여부, 컨텍스트 폴백 세부)은 이 세션에서 LiteLLM 코드로 확인하지 않았다. 위 동작의 근거는 표의 이유이며, LiteLLM 과 같다는 것을 근거로 삼지 않는다.

## 10. 변경 이력

- 2026-09-27 검토 반영(독립 검토 2건). 취소 규약(1.1: 언어별 취소 수단, RouterError 로 감싸지 않음, 취소를 network_error 로 오분류하지 않는 법)과 참조 구현 `route(..., { signal })`·`cancel_in_flight` 케이스를 추가했다. 시계(1.2, 절전 포함), 동시 호출(1.3, 쿨다운 중 실패도 기록), 모바일 수명주기(1.4, 백그라운드 시 취소, 오프라인 위험은 수용)를 새로 적었다. 3.6 에 transport 규칙을 넣었다. 한 시도는 HTTP 요청 한 번이고, 자체 재시도와 리다이렉트는 쓰지 않으며(3xx 는 fatal, RN 기기만 예외), 플랫폼 타임아웃은 끄거나 늘린다. ms 환산은 반올림이다. 컨텍스트 문구 검사를 ASCII 소문자화로 고정했다. `parseConfig` 규칙(모르는 키는 모든 레벨에서 무시, null 은 없음, 4.0 은 정수)과 거부 목록을 `configCases` 42개로 고정했다. Transport 반환 필드는 `text` 로 통일했다. `deploymentStates` 범위와 `cooldownUntilMs` 를 정했고, 3.5 의 "하나라도" 규칙을 명시했으며, 절 번호와 LiteLLM 근거 문구를 고쳤다. 뮤테이션 구멍을 막는 케이스도 추가했다. 가중치 재계산은 rng 0.3 으로 바꿨다. 새 케이스는 재방문 금지 실검증, FIFO, 컨텍스트 시도 한도, 섞인 사유, 시작 제외 섞임, cooldownSeconds 10, ASCII 소문자화, 본문 중 타임아웃, slow 케이스다. 기존 케이스에는 599, 302, `choices:{}`, `[]`, `error:null`, `bodyContains`, `cooldownUntilMs` 비교를 더했다. 모의 서버는 잘못된 시나리오에 400 을 주고, 예외가 나도 죽지 않는다. `bodyDelayMs`, keep-alive 120초, 와일드카드 바인딩 시 127.0.0.1 URL 출력, `--exit-on-stdin-close` 도 넣었다. 러너는 잘못된 인자와 0 케이스를 실패로 처리한다. 라이브 스모크는 timeoutSeconds 20 과 5분 제한을 둔다.
- 2026-09-27 메인 결정. 오프라인 뒤 회복용 `resetState()` 를 공개 API 에 추가했다(1절, 1.4). 적합성 단계 `reset` 과 케이스 `reset_state_clears_cooldown` 을 넣었다. 테스트 케이스 생성기를 `spec/reference/gen-cases.mjs` 로 옮겼다. 케이스를 고칠 때는 이 파일을 고치고 다시 생성한다. JSON 이 기준이다.
