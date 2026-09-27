# FreeLLMRouter (Swift Package)

iOS 네이티브 앱 안에서 무료 LLM 제공처를 직접 부르며 폴백하는 라우터. 명세는 `../spec/SPEC.md`.
iOS 15+ / macOS 12+, 의존성 없음 (URLSession + async/await, 상태는 actor).

## 설치

저장소 루트가 아니라 `swift/` 폴더에 `Package.swift` 가 있으므로 **로컬 패키지**로 추가한다.

- Xcode: File → Add Package Dependencies… → Add Local… → `free-llm-router/swift`
- 다른 패키지에서: `.package(path: "../free-llm-router/swift")`, 타깃 의존성 `"FreeLLMRouter"`

`spec/models.json` 을 앱 번들 리소스로 넣는다(또는 원격 JSON 으로 받아 같은 `parseConfig` 사용).

## 키 보관 (HANDOFF 6절)

소스에 키를 쓰지 않는다. xcconfig(git 제외) → Info.plist → 런타임.

```
// Secrets.xcconfig  (.gitignore 에 추가, 타깃 Build Settings 의 Configuration 파일로 지정)
OPENROUTER_API_KEY = sk-or-...
```
Info.plist 에 `OPENROUTER_API_KEY` = `$(OPENROUTER_API_KEY)` 항목을 추가하고:

```swift
let key = Bundle.main.object(forInfoDictionaryKey: "OPENROUTER_API_KEY") as? String ?? ""
```
빌드 결과물에서는 추출 가능하다. 본인 전용 앱이라 허용한 위험이다.

## 쓰는 법

```swift
import FreeLLMRouter

let json = try String(contentsOf: Bundle.main.url(forResource: "models", withExtension: "json")!, encoding: .utf8)
let router = Router(config: try parseConfig(json), keys: ["openrouter": key])

do {
    let r = try await router.route(group: "chat", request: [
        "messages": [["role": "user", "content": "안녕"]],
        "max_tokens": 256,
    ])
    print(r.content ?? "", r.deploymentId, r.group)       // r.response 는 응답 JSON 전체
} catch let e as RouterError {
    print(e.kind.rawValue, e.status as Any, e.attempts)  // invalid_request / non_retryable / ...
} catch is CancellationError {
    // 호출자가 취소함. 실패 기록은 남지 않는다
}
```

- `route` 는 `CancellationError`·`RouterError` 외에는 던지지 않는다. 설정 오류는 `parseConfig` 의 `ConfigError`.
- `deploymentStates()`, `resetState()` 는 actor 메서드라 `await` 로 부른다.
- 테스트용 주입: `Router(config:keys:options: RouterOptions(transport:rng:now:))`.

### 취소와 백그라운드 (SPEC 1.1, 1.4)

취소 수단은 Swift `Task` 취소다. 앱이 백그라운드로 가면 진행 중인 `route` 를 취소한다.

```swift
struct ChatView: View {
    @Environment(\.scenePhase) private var phase
    @State private var job: Task<Void, Never>?

    var body: some View {
        Button("보내기") {
            job = Task {
                do { let r = try await router.route(group: "chat", request: req); /* 표시 */ }
                catch is CancellationError { /* 무시 */ }
                catch { /* RouterError 표시 */ }
            }
        }
        .onChange(of: phase) { p in if p == .background { job?.cancel() } }
    }
}
```
SwiftUI `.task { }` 안에서 부르면 뷰가 사라질 때 자동으로 취소된다.
`UIApplication.beginBackgroundTask(expirationHandler:)` 를 쓴다면 만료 핸들러에서 `job?.cancel()`.

### 오프라인 뒤 회복: `resetState()`

오프라인 동안 쌓인 실패로 배포들이 쿨다운에 들어가 있을 수 있다. 연결이 돌아오면 비운다.

```swift
import Network

let monitor = NWPathMonitor()
monitor.pathUpdateHandler = { path in
    if path.status == .satisfied { Task { await router.resetState() } }
}
monitor.start(queue: .global())
```

## 테스트

```bash
cd swift
swift test                                        # 단위 + 적합성(memory, http) + configCases. live 는 SKIP
FLR_SLOW=1 swift test --filter ConformanceTests/testMockServerHTTP   # slow 케이스(약 16초) 포함
FLR_CASE=cancel_in_flight swift test --filter ConformanceTests      # 한 케이스만
OPENROUTER_API_KEY=... swift test --filter LiveSmokeTests           # 실제 OpenRouter (직접 실행)
```

- 케이스는 `../spec/test-cases.json` 을 그대로 읽는다(`FLR_SPEC_DIR` 로 바꿀 수 있음).
- http 모드는 `node ../spec/mock-server/server.mjs` 를 직접 띄운다(`FLR_MOCK_URL` 이 있으면 그 서버). node 가 없으면 눈에 띄게 SKIP.
- 출력에 케이스 × 모드 PASS/FAIL/SKIP 표가 찍힌다.

- 케이스마다 시간 제한(일반 30초, slow 40초)이 있어 라우팅이 무한 루프에 빠져도 멈추지 않고 `case timeout` FAIL 로 끝난다.

## 참조 구현(JS)과 알려진 차이

- 응답 JSON 중첩은 512단까지. 더 깊으면 `bad_body` (참조 구현은 받는다). 파서는 반복식이라 스택을 쓰지 않지만,
  결과 값의 비교·직렬화·해제가 재귀라 Debug 빌드의 async 스레드에서도 안전한 한도로 잘랐다.
- Swift `String` 은 정규 등가(NFC/NFD)로 비교한다. `"café"`(NFC) 와 `"cafe\u0301"`(NFD) 를 같은 id·그룹 이름·JSON 키로 본다
  (참조 구현은 코드 유닛으로 비교해 다르게 본다). id·그룹 이름은 ASCII 로 쓰면 차이가 없다.
- 응답 본문 앞의 UTF-8 BOM 은 fetch 의 `text()` 처럼 떼고 읽는다.

iOS 컴파일 확인:

```bash
xcodebuild build -scheme FreeLLMRouter -destination 'generic/platform=iOS Simulator'
# Xcode 에 iOS 플랫폼이 설치돼 있지 않으면 위 명령이 "iOS 18.4 is not installed" 로 멈춘다. 그때는:
swift build --target FreeLLMRouter --triple arm64-apple-ios15.0-simulator \
  --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path .build/ios-sim
swift build --target FreeLLMRouter --triple arm64-apple-ios15.0 \
  --sdk "$(xcrun --sdk iphoneos --show-sdk-path)" --scratch-path .build/ios-device
```
대체 경로는 컴파일만 확인한다. iOS 플랫폼이 설치된 맥에서 위 `xcodebuild` 명령을 한 번 돌려 확인할 것.
