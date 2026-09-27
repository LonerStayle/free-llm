# gateway — 데스크톱·개발용 로컬 LiteLLM 게이트웨이

내 앱(안드로이드 등)에서 무료 LLM 을 부르기 위한 로컬 게이트웨이.
맥에서 LiteLLM 프록시를 띄우고, 기기는 OpenAI 호환 API 로 호출한다. 개인·테스트용이다.

```
[에뮬레이터 / 폰 / 다른 PC] --HTTP--> 맥 :4100 (LiteLLM) --> OpenRouter 등 무료 모델
```

- 앱은 `model` 에 그룹 이름만 보낸다: `chat`(일반 대화), `fast`(짧은 요청)
- 모델 하나가 429·503 을 주면 같은 그룹의 다른 모델로, 그룹이 다 막히면 다른 그룹으로 넘어간다
- 실제 제공처 API 키는 맥의 `.env` 에만 있다. 앱에는 게이트웨이 키(`LITELLM_MASTER_KEY`)만 넣는다

## 실행

```bash
cp .env.example .env && chmod 600 .env    # 키 채우기 (OPENROUTER_API_KEY 필수)
docker compose up -d
scripts/test-call.sh                      # 응답 오면 성공
```

Docker 없이: `pip install 'litellm[proxy]'` 후 `set -a; . ./.env; set +a; litellm --config config.yaml --port 4100`

포트는 4100. `claude-free-settings` 프록시(4000)와 동시에 띄워도 충돌하지 않는다.

## 기기에서 연결

| 기기 | 앱의 GATEWAY_URL | 준비 |
|---|---|---|
| 에뮬레이터 | `http://10.0.2.2:4100` | 없음 |
| USB 연결 폰 | `http://localhost:4100` | `adb reverse tcp:4100 tcp:4100` (연결할 때마다) |
| 같은 Wi-Fi 폰 | `http://<맥IP>:4100` | `.env` 에 `BIND_ADDR=0.0.0.0` 후 `docker compose up -d` |
| 집 밖 (LTE 등) | `http://<맥이름>:4100` | Tailscale (선택, 아래) |

맥 IP 확인: `ipconfig getifaddr en0`. 공유기가 IP 를 바꿀 수 있으니 공유기에서 맥 IP 를 고정해 두면 편하다.

`BIND_ADDR=0.0.0.0` 이면 같은 Wi-Fi 의 누구나 접속을 시도할 수 있다. 게이트웨이 키가 막아 주지만 카페 같은 공용 Wi-Fi 에서는 `127.0.0.1` 로 되돌린다.

### Tailscale (선택)

맥과 폰이 다른 네트워크에 있을 때만 필요하다. 집에서만 쓰면 없어도 된다.

1. 맥과 폰에 Tailscale 설치, 같은 계정으로 로그인
2. `.env` 에 `BIND_ADDR=0.0.0.0` (Tailscale 인터페이스로도 받기 위해)
3. 앱에서 `http://<맥의 Tailscale 이름>:4100` 호출

Tailscale 기기끼리만 보이므로 인터넷에는 공개되지 않는다.

## 안드로이드

`examples/android/` 에 예제가 있다.

1. `local.properties` (git 에 안 올라감)에 값 추가
   ```
   gateway.url=http://10.0.2.2:4100
   gateway.key=sk-...
   ```
2. `app/build.gradle.kts`
   ```kotlin
   import java.util.Properties
   val props = Properties().apply { rootProject.file("local.properties").inputStream().use(::load) }
   android {
       buildFeatures { buildConfig = true }
       defaultConfig {
           buildConfigField("String", "GATEWAY_URL", "\"${props["gateway.url"]}\"")
           buildConfigField("String", "GATEWAY_KEY", "\"${props["gateway.key"]}\"")
       }
   }
   ```
3. `network_security_config.xml` 을 `src/debug/res/xml/` 에 두고 debug 매니페스트에서 연결
   (`android:networkSecurityConfig="@xml/network_security_config"`). http 를 허용하기 위해서다
4. `INTERNET` 권한 추가, `GatewayClient().ask("안녕")` 호출

다른 플랫폼도 같다. `POST /v1/chat/completions` 에 `Authorization: Bearer <키>` 를 붙이면 된다.
OpenAI SDK 를 쓴다면 base URL 만 게이트웨이 주소(`.../v1`)로 바꾼다.

## 모델 관리

```bash
scripts/check-models.sh                # 등록된 모델이 아직 무료로 살아 있는지
scripts/check-models.sh --candidates   # 추가할 만한 OpenRouter 무료 모델
```

`config.yaml` 을 고친 뒤 `docker compose restart`.

## 모의 검증 (키 없이)

실제 제공처·키 없이 `spec/mock-server` 를 제공처로 두고 LiteLLM 의 재시도·쿨다운·폴백을 관찰한다.
Docker Desktop 과 Node 18+ 가 필요하다. 이미지는 `docker-compose.yml` 과 같은 v1.101.0 이다.

```bash
gateway/test/run-mock.sh                          # compose 문법 확인 + 전체 시나리오 (약 10분)
gateway/test/run-mock.sh --scenario 400_no_retry  # 하나만
gateway/test/run-mock.sh --out /tmp/r.json        # 결과 JSON 저장
```

- `test/config.mock.yaml`: `router_settings` 는 `config.yaml` 과 같고, `model_list` 만 모의 서버(`openai/chat-a` 등, 더미 키)로 바꿨다
- 시나리오마다 같은 응답 스크립트로 명세 참조 라우터(`spec/reference/router.mjs`)와 LiteLLM 을 돌린다. 모의 서버 `/__log` 로 어느 모델이 몇 번 불렸는지 세어 나란히 출력한다(`MATCH`/`DIFF`)
- 쿨다운 상태를 비우려고 시나리오마다 컨테이너(`flr-gateway-mocktest`, 포트 4100)를 새로 띄운다. 4100 을 이미 쓰고 있으면 `--port` 로 바꾼다
- `DIFF` 는 실패가 아니라 관찰 결과다. 인프라 오류만 exit 1

관찰 결과 (2026-09-27, LiteLLM 1.101.0). 앱 라우터(spec)는 일부러 다르게 동작하는 곳이 있다.

| 상황 | LiteLLM (이 설정) | spec |
|---|---|---|
| `rpm` | 분당 **한도**로도 쓴다. chat 합계 20/분을 넘으면 fast 로 폴백, 둘 다 차면 429 `No deployments available` | 가중치만 |
| 429 | 한 번에 60초 쿨다운 | 3번째 실패에 쿨다운 |
| 5xx | 분당 실패율 50% 초과 + 5요청 이상일 때 쿨다운 (관찰상 5~6회째) | 3번째 실패에 쿨다운 |
| `allowed_fails: 3` | LiteLLM 기본값과 같아서 **무시**된다. `2` 로 두면 429·5xx 모두 대개 3번째 실패에 쿨다운(spec 과 비슷). 쿨다운 반영이 비동기라 한 요청 안에서 같은 배포를 연달아 고르면 3~6회까지 불린다 | - |
| 그룹 안 재시도 | 1+3회. 같은 배포를 다시 고르기도 한다 | 1+3회, 같은 배포는 한 요청에 한 번 |
| 400 | 그룹 안 재시도는 없지만 `fallbacks` 로 fast 로 간다 | 즉시 실패 |
| 401·403 | 그룹 안에서 재시도한 뒤 fast 로 폴백 | 즉시 실패 |
| 404 | 그룹 안 재시도 없이 fast 로 폴백, 즉시 쿨다운 | 같은 그룹 다른 배포, 실패 +1 |
| fast 컨텍스트 초과 | fast 1회 뒤 바로 chat | fast 의 남은 배포를 다 시도한 뒤 chat |
| chat 컨텍스트 초과 | 1회 뒤 400 으로 실패 (fast 로 안 감) | chat 배포를 다 시도한 뒤 실패 (fast 로 안 감) |
| 쿨다운 길이 | 60초 뒤 복귀 확인 | 같음 |

## 한계

- 맥이 켜져 있고 잠자기가 아니어야 한다
- 무료 한도는 제공처 키 단위다. 많이 부르면 429 가 난다
- Gemini 무료분·Mistral 기본값은 입력을 학습에 쓴다 (config.yaml 에서 기본 주석 처리)
- 다른 사람에게 배포하는 앱용이 아니다. 그때는 서버 배포 + 사용자 인증 + 유료 모델이 필요하다
