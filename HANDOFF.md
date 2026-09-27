# 인수인계: free-llm-router

작성 2026-09-27. 이전 세션(`~/js-work/claude-free-settings`)에서 대화로 정한 내용을 옮겼다.
이 문서를 읽은 세션이 이어서 설계·구현한다. 결정이 바뀌면 이 문서를 고친다.

## 1. 목표

내가 만드는 앱에서 **무료 LLM 을 끊김 없이** 쓰기 위한 폴백 라우터.
무료 모델은 429(한도)·503(과부하)가 잦고 목록에서 자주 빠지므로,
여러 모델을 돌려 쓰다가 하나가 막히면 자동으로 다음 모델로 넘어가야 한다.

- 대상 기기: **Android 와 iOS 둘 다**
- 대상 개발 방식: **Android 네이티브(Kotlin), iOS 네이티브(Swift), Kotlin Multiplatform, Flutter, React Native 다섯 가지 모두 고려**
  (KMP·Flutter·RN 은 한 코드로 Android·iOS 를 같이 지원한다)
- 사용 범위: **각자 자기 기기에서, 본인만 쓰는 앱**. 여러 사람이 쓰는 백엔드가 아니다
- 기원: `claude-free-settings` 의 LiteLLM 프록시 설정 (Claude Code 무료 모델 폴백용)

## 2. 확정된 결정과 이유

| 결정 | 이유 |
|---|---|
| 모바일은 **로컬 서버 없이 앱 안에 폴백 로직을 넣는다** | LiteLLM 은 Python 서버라 Android/iOS 앱 안에서 띄울 수 없다. 원래 구상("앱이 자기 localhost 게이트웨이를 부른다")은 데스크톱에서만 가능 |
| 앱이 제공처(OpenRouter 등)를 **직접** 호출한다 | 중간 서버가 없으니 Wi-Fi·IP·Tailscale 문제가 없다 |
| 제공처 API 키가 앱 안에 들어가는 건 **허용** | 본인 전용 앱이라서. 남에게 APK/IPA 를 배포하면 키가 노출된다 → 그때는 서버 방식으로 전환해야 함 |
| 데스크톱·개발용으로 LiteLLM 게이트웨이도 유지 (`gateway/`) | 맥에서 띄우면 에뮬레이터·데스크톱 앱이 localhost 로 쓸 수 있다 |
| (2026-09-27) `kotlin/` 을 없애고 **`kmp/` 하나로 통합** | KMP commonMain 을 Android 네이티브 앱에서 그대로 쓴다. 구현 하나를 줄인다 |
| (2026-09-27) iOS 네이티브는 **별도 Swift Package** (`swift/`) | 폴백 로직이 작아 URLSession 으로 따로 짜는 게 가볍다. 순수 Swift 앱이 Kotlin/Native 프레임워크에 묶이지 않는다 |
| (2026-09-27) OpenRouter `models` 1단계 없이 **4절 전체 명세를 바로 구현** | 다른 제공처 섞기를 처음부터 지원. `models` 배열은 명세의 선택 기능으로만 둔다 |
| (2026-09-27) 첫 구현은 **KMP**, 이어서 Swift·Flutter·RN 을 병렬 구현 | KMP 하나로 Android·iOS 양쪽을 먼저 검증 |
| (2026-09-27) e2e 는 **로컬 모의 제공처 서버**로 결정적으로 검증. 실제 제공처 호출(live)은 `OPENROUTER_API_KEY` 환경변수가 있을 때만 도는 스모크 테스트로 준비만 | 키 파일을 자동화가 읽지 않는다. live 는 사용자가 직접 실행 |
| (2026-09-27) iOS 검증은 **macOS 타깃으로 대체** (Swift: `swift test`, KMP: macosArm64). iOS 는 컴파일만 확인 | 이 맥에 iOS 시뮬레이터 런타임이 없고 디스크 여유가 13GB 뿐 |

## 3. 폴더 구조 (현재 → 목표)

```
free-llm-router/
├── HANDOFF.md            이 문서
├── CLAUDE.md             세션 진입 안내
├── gateway/              ✅ 완료 (뼈대). 데스크톱·개발용 LiteLLM
│   ├── docker-compose.yml   포트 4100 (claude-free 프록시 4000 과 충돌 방지)
│   ├── config.yaml          그룹 chat / fast
│   ├── scripts/check-models.sh, test-call.sh
│   └── examples/android/    게이트웨이를 원격 호출하는 예제 (모바일 내장 방식과는 별개)
├── spec/                 ⬜ 할 일. 플랫폼 공통 명세 + 모델 목록 JSON
├── swift/                ⬜ iOS 네이티브 (Swift Package)
├── kmp/                  ⬜ Kotlin Multiplatform (Android 네이티브 + iOS) — kotlin/ 통합
├── flutter/              ⬜ Dart 패키지
└── react-native/         ⬜ TypeScript 모듈
```

`kotlin/` 은 `kmp/` 로 통합했고, `swift/` 는 별도 구현으로 정했다 (2절 2026-09-27 결정).

## 4. 공통 폴백 동작 (모든 플랫폼이 똑같이 따를 명세)

`gateway/config.yaml` 의 LiteLLM 라우터 동작을 그대로 옮긴다.

1. **그룹**: 호출자는 `chat` 또는 `fast` 만 지정한다. 그룹마다 배포(제공처+모델) 목록이 있다
2. **선택**: 그룹 안에서 쿨다운 중이 아닌 배포 중 하나를 `rpm` 가중치로 무작위 선택 (LiteLLM `simple-shuffle`)
3. **실패 처리**
   - 429, 500~504, 타임아웃, 네트워크 오류 → 해당 배포 실패 카운트 +1, 같은 그룹의 다른 배포로 재시도
   - 실패가 3번 쌓인 배포는 60초 쿨다운 (`allowed_fails: 3`, `cooldown_time: 60`)
   - 400(요청 오류), 401/403(키 오류)은 재시도하지 않고 바로 올린다
   - 그룹 안 재시도 최대 3번 (`num_retries: 3`)
4. **그룹 폴백**: 그룹 전체가 실패하면 `chat → fast`, `fast → chat`
5. **컨텍스트 초과**: `fast` 에서 컨텍스트 길이 오류가 나면 `chat` 으로 (큰 컨텍스트 모델이 거기 있음)
6. **API 형식**: 모든 제공처를 OpenAI 호환 `/chat/completions` 로 부른다
   - OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`,
     Mistral `https://api.mistral.ai/v1`, Requesty `https://router.requesty.ai/v1`,
     Gemini 는 OpenAI 호환 엔드포인트 `https://generativelanguage.googleapis.com/v1beta/openai/` (동작 확인 필요)
7. 쿨다운 상태는 메모리에만 둔다 (앱 재시작 시 초기화로 충분)
8. 스트리밍은 1차 범위 밖. 필요하면 명세에 추가

**더 간단한 대안**: OpenRouter 는 요청 본문에 `"models": [A, B, C]` 를 넣으면 서버 쪽에서 폴백해 준다.
OpenRouter 모델끼리만 되지만 코드가 HTTP 호출 하나로 끝난다. 1단계로 이것만 구현하고,
다른 제공처를 섞는 로직은 2단계로 미루는 것도 방법이다. (`models` 배열 최대 개수 등 세부 규칙은 문서 확인 필요)

## 5. 모델 목록

현재 목록은 `gateway/config.yaml` (2026-09-26 기준, `claude-free-settings` 에서 가져옴).
모바일 구현이 같은 목록을 쓰도록 `spec/models.json` 으로 뽑는 걸 권장한다. 플랫폼마다 하드코딩하면 다섯 군데를 고쳐야 한다.
원격 JSON 으로 받아오게 하면 앱 업데이트 없이 목록을 바꿀 수 있다 (선택).

- 기본 활성: OpenRouter `:free` 모델만 (키 하나로 시작 가능)
- 주석 처리: Requesty, Groq, Gemini, Mistral. **Gemini 무료분과 Mistral 기본값은 입력을 학습에 씀**
- 무료 모델은 자주 빠진다 → `gateway/scripts/check-models.sh` 로 확인 (`--candidates` 로 신규 후보)
- Groq 는 8K TPM → 입력 6000 토큰 넘는 요청에서는 제외 (`max_input_tokens`)

## 6. 키 보관 (모바일)

- 소스 코드에 직접 쓰지 않는다. Android: `local.properties` → `BuildConfig`, Flutter: `--dart-define`,
  RN: `react-native-config` 등, iOS: xcconfig (git 제외)
- 이렇게 해도 빌드 결과물에서는 추출 가능하다. 본인 전용이라 허용한 위험이다 (2절)

## 6-1. iOS 주의사항

- **앱 내장 방식(제공처 직접 호출)**: 제공처가 모두 https 라 ATS 설정 없이 동작한다
- **`gateway/` 를 iOS 에서 부를 때** (개발용)
  - 시뮬레이터: 맥과 네트워크를 공유하므로 `http://localhost:4100` 로 바로 된다 (Android 의 10.0.2.2·adb reverse 불필요)
  - 실기기(같은 Wi-Fi): `http` 라서 ATS 가 막는다 → Info.plist 에 `NSAppTransportSecurity > NSAllowsLocalNetworking = YES` (디버그 전용 권장)
  - 실기기에서 LAN 주소로 접속하면 iOS 14+ 가 로컬 네트워크 권한을 묻는다 → `NSLocalNetworkUsageDescription` 문구 필요
  - USB 연결로 localhost 포워딩하는 adb reverse 같은 기본 도구는 없다. 같은 Wi-Fi 또는 Tailscale 사용
- 키 보관: xcconfig(git 제외) → Info.plist 변수 → `Bundle.main.object(forInfoDictionaryKey:)`
- iOS 는 앱이 백그라운드로 가면 네트워크 요청이 곧 중단된다. 긴 재시도 루프 중 앱이 내려가면 실패로 처리하면 된다
- 실기기 설치는 Apple 개발자 계정이 필요하다 (무료 계정은 7일마다 재설치)

## 7. 아직 안 한 것 / 확인 안 된 것

- `gateway/` 는 파일만 만들었고 **실제로 띄워서 호출해 보지 않았다** (`.env` 없음). YAML 문법과 `docker compose config` 만 통과
- `gateway/.env` 는 `.env.example` 복사 후 채운다. OpenRouter 키는 `claude-free-settings/.env` 의 것을 써도 됨. `LITELLM_MASTER_KEY` 는 새로 생성
- (2026-09-27 문서 확인) Gemini OpenAI 호환: base `https://generativelanguage.googleapis.com/v1beta/openai/`, `Authorization: Bearer <GEMINI_API_KEY>`, 모델명은 `models/` 접두어 없이 (`gemini-...`). 실제 호출은 아직 안 해 봄
- (2026-09-27 문서 확인) OpenRouter `models` 배열: 폴백 사유는 컨텍스트 길이 오류·모더레이션·레이트리밋·다운타임. 응답의 `model` 필드가 실제 쓰인 모델. 과금은 실제 쓰인 모델 기준. `models` 배열 최대 개수는 문서에 명시 없음 (Anthropic 호환 `fallbacks` 는 최대 3개)
- 커밋 없음 (`git init` 만 됨)

## 8. 다음 세션이 할 일 (제안 순서)

1. 3절 `kotlin/` vs `kmp/` 통합 여부, 4절 1단계(OpenRouter `models`) 먼저 할지 정하기
2. `spec/` 작성: 동작 명세(4절) + `models.json` + 플랫폼 공통 테스트 케이스(429 → 다음 모델, 3회 실패 → 쿨다운, 400 → 즉시 실패, 그룹 폴백)
3. 플랫폼 하나 먼저 구현해 명세 검증 → 나머지로 확장 (Android 와 iOS 양쪽에서 동작 확인)
4. `gateway/` 실제 기동 확인
