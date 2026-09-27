# free-llm-router — Kotlin Multiplatform

`spec/SPEC.md` 를 따르는 앱 내장 폴백 라우터. Android 네이티브 앱과 KMP 앱(Android·iOS)이 같은 라이브러리를 쓴다.

- 타깃: `androidTarget`(라이브러리), `jvm`(호스트 테스트), `iosArm64`, `iosSimulatorArm64`, `macosArm64`
- HTTP: Ktor — Android/JVM 은 OkHttp 엔진, Apple 은 Darwin 엔진. 재시도·리다이렉트·자체 타임아웃은 끈다(SPEC 3.6)
- 버전: Kotlin 2.2.20, AGP 8.11.1, Gradle 8.14, Ktor 3.3.3, coroutines 1.10.2, serialization 1.9.0, JDK 17

## 설치

`local.properties` 에 `sdk.dir=/Users/<you>/Library/Android/sdk` (git 제외). 앱 프로젝트에서 composite build 로 붙인다.

```kotlin
// 앱의 settings.gradle.kts
includeBuild("../free-llm-router/kmp")

// 앱 모듈 (또는 KMP shared 모듈의 commonMain)
dependencies { implementation("dev.freellmrouter:router:0.1.0") }
```

Android: 라이브러리 매니페스트가 `android.permission.INTERNET` 을 선언해 앱에 병합된다. 앱에서 병합을 막았다면
`<uses-permission android:name="android.permission.INTERNET"/>` 을 직접 넣는다(없으면 모든 시도가 `network_error`).

## 앱에서 쓰기

```kotlin
val config = parseConfig(modelsJsonText)               // spec/models.json 형식. 틀리면 ConfigError
val router = Router(config, mapOf("openrouter" to BuildConfig.OPENROUTER_API_KEY))

val request = buildJsonObject {
    putJsonArray("messages") { addJsonObject { put("role", "user"); put("content", "안녕") } }
}
try {
    val r = router.route("chat", request)               // suspend. model 은 라우터가 채운다
    println("${r.deploymentId} (${r.group}): ${r.response}")
} catch (e: RouterError) {
    println("${e.kind} status=${e.status} attempts=${e.attempts}")   // e.kind.value == "all_failed" 등
}
```

`Router(config, keys, RouterOptions(transport, rng, now))` — 옵션을 비우면 플랫폼 HTTP, 플랫폼 난수, 절전 포함 시계
(Android `SystemClock.elapsedRealtime()`, Apple `CLOCK_MONOTONIC`)를 쓴다. 기본 transport 를 쓰면 다 쓴 뒤 `router.close()`.
`deploymentStates()` 는 진단용 상태, `resetState()` 는 실패 기록·쿨다운 초기화.

### 키 보관 (HANDOFF 6절)

소스에 키를 쓰지 않는다. Android: `local.properties` → `BuildConfig`.

```kotlin
// app/build.gradle.kts
val localProps = java.util.Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
android {
    buildFeatures { buildConfig = true }
    defaultConfig {
        buildConfigField("String", "OPENROUTER_API_KEY", "\"${localProps.getProperty("OPENROUTER_API_KEY", "")}\"")
    }
}
```

iOS(KMP 앱): xcconfig(git 제외) → Info.plist 변수 → Swift 에서 `Bundle.main.object(forInfoDictionaryKey:)` 로 읽어 Kotlin 쪽 `keys` 맵으로 넘긴다.
빌드 결과물에서는 키를 꺼낼 수 있다. 본인 전용 앱이라 허용한 위험이다.

### 취소 · 백그라운드 · 연결 복구 (SPEC 1.1, 1.4)

취소는 코루틴 취소다. 취소되면 `CancellationException` 이 나고(`RouterError` 아님) 진행 중이던 시도는 실패로 기록되지 않는다.

```kotlin
// Android: 앱이 백그라운드로 가면 진행 중인 route 를 취소
class ChatRepo(private val router: Router) : DefaultLifecycleObserver {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null

    fun ask(req: JsonObject) {
        job = scope.launch {
            try {
                show(router.route("chat", req))
            } catch (e: RouterError) {
                showError(e)          // CancellationException 은 잡지 않는다
            }
        }
    }
    override fun onStop(owner: LifecycleOwner) { job?.cancel() }   // ProcessLifecycleOwner.get().lifecycle.addObserver(repo)
}

// 연결이 돌아오면 쿨다운을 비운다 (오프라인 동안 쌓인 network_error 때문에 all_failed 가 나지 않게)
connectivityManager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = router.resetState()
})
```

iOS(KMP 앱)는 Swift 의 Task 취소가 Kotlin 코루틴으로 전달되지 않는다. shared 코드의 `CoroutineScope` 에서 `route` 를 돌리고
`scenePhase == .background` 에서 그 `Job` 을 `cancel()` 하는 함수를 Swift 에 노출한다. 연결 복구(`NWPathMonitor` 의 `.satisfied`)에서 `resetState()`.
Swift 에서 `route`·`parseConfig` 를 직접 불러도 된다. `@Throws` 가 붙어 있어 `RouterError`·`ConfigError`·취소가
`try`/`NSError` 로 온다(`catch let e as NSError`, 원래 Kotlin 예외는 `e.userInfo["KotlinException"]`).

## 테스트

JDK 17 로 실행한다: `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`.
테스트는 `spec/` 을 복사하지 않고 읽는다(`FLR_SPEC_DIR`, 기본 `../spec`). HTTP 모드는 `node` 로 모의 서버를 직접 띄운다
(JVM: ProcessBuilder, macOS: NSTask). `FLR_MOCK_URL` 이 있으면 그 서버를 쓴다. 서버를 못 띄우면 SKIP 을 크게 출력한다(`-Pflr.requireHttp` 면 실패).

```bash
./gradlew :router:jvmTest                 # 메모리 + 모의 서버 HTTP(OkHttp) 41 cases, configCases 42, 단위 테스트
./gradlew :router:macosArm64Test          # 메모리 + 모의 서버 HTTP(Darwin) — iOS 대체 검증
./gradlew :router:jvmTest -Pflr.slow      # slow_response_within_timeout(약 16초) 포함. transport 설정을 바꾸면 반드시
./gradlew :router:macosArm64Test -Pflr.slow
./gradlew :router:jvmTest -Pflr.case=retry_timeout   # 케이스 하나만 (FLR_CASE 환경변수도 된다)
./gradlew :router:linkDebugFrameworkIosSimulatorArm64 :router:linkDebugFrameworkIosArm64   # iOS 는 링크까지만
./gradlew :router:assembleRelease         # Android AAR
./gradlew --stop
```

iOS 시뮬레이터 테스트 태스크는 기본으로 꺼져 있다(이 맥에 런타임 없음). 켜려면 `-Pflr.iosSimTests`.

라이브 스모크(`spec/live-smoke.md`)는 일반 실행에서 빠지고, 지정했을 때만 돈다. 키가 없으면 `LIVE SKIP` 후 skip.

```bash
OPENROUTER_API_KEY=... ./gradlew :router:jvmTest --tests '*LiveSmokeTest*'
```
