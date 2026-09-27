# free-llm-router (React Native)

앱 안에서 무료 LLM 제공처(OpenRouter 등)를 직접 부르며, 막히면(429·5xx·타임아웃 등) 다른 모델·그룹으로 자동 폴백하는 라우터.
동작 명세는 [`../spec/SPEC.md`](../spec/SPEC.md). 네이티브 모듈 없는 순수 TypeScript이고, 전역 `fetch`·`AbortController`·`setTimeout` 만 쓴다(Hermes 에서 동작).

## 설치

```bash
# 이 폴더를 빌드한 뒤 앱에서 로컬 경로로 설치
cd react-native && npm install && npm run build
cd <앱> && npm install ../free-llm-router/react-native
```

`dist/` 는 ESM 전용(ES2019, `"type": "module"`) + `.d.ts` 다. Metro 가 `main`/`react-native` 필드로 `dist/index.js` 를 읽는다.
앱의 Jest(`react-native` 프리셋)는 `node_modules` 의 ESM 을 변환하지 않으므로 `transformIgnorePatterns` 에 넣는다:
`transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|free-llm-router)/)']`.

## 앱에서 쓰기

키는 소스에 쓰지 않는다(HANDOFF 6절). 예: `react-native-config` 로 `.env`(git 제외)의 값을 읽는다. 빌드 결과물에서는 추출할 수 있다(본인 전용이라 허용한 위험).

```ts
import Config from 'react-native-config';
import { Router, RouterError, parseConfig } from 'free-llm-router';
import modelsJson from './models.json'; // spec/models.json 을 앱에 넣거나 원격으로 받아 온다

const router = new Router(parseConfig(JSON.stringify(modelsJson)), {
  openrouter: Config.OPENROUTER_API_KEY ?? '',
});

async function ask(text: string, signal?: AbortSignal) {
  try {
    const r = await router.route('chat', { messages: [{ role: 'user', content: text }] }, { signal });
    console.log(r.response.choices, r.deploymentId, r.group, r.attempts);
  } catch (e) {
    if (e instanceof RouterError) console.warn(e.kind, e.status, e.attempts); // invalid_request | non_retryable | context_window_exceeded | all_failed
    else if ((e as Error).name === 'AbortError') { /* 취소 */ }
    else throw e;
  }
}
```

### 취소

`route(group, request, { signal })`. 취소되면 `signal.reason` 을 그대로 던진다(`RouterError` 로 감싸지 않음, 실패 기록도 남기지 않음).
Hermes 의 오래된 `AbortController` 폴리필처럼 `reason` 이 없으면 라이브러리의 `AbortError`(`name === 'AbortError'`)를 던진다.

### 백그라운드·연결 복구 (SPEC 1.4)

```ts
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

let inflight = new AbortController();
AppState.addEventListener('change', (s) => {
  if (s === 'background') { inflight.abort(); inflight = new AbortController(); } // 진행 중 route 취소
});

// 끊김 → 연결 으로 바뀔 때만 비운다(구독 직후 첫 콜백·Wi-Fi↔셀룰러 전환은 무시, 정당한 429 쿨다운 유지)
let wasConnected = true;
NetInfo.addEventListener((s) => {
  const now = s.isConnected === true;
  if (now && !wasConnected) router.resetState(); // 오프라인 동안 쌓인 실패·쿨다운 비우기
  wasConnected = now;
});

async function askInForeground() {
  return router.route('chat', { messages: [{ role: 'user', content: '안녕' }] }, { signal: inflight.signal });
}
```

오프라인임을 알면 `route` 를 부르지 않는 것도 권장한다. 상태(실패 기록·쿨다운)는 메모리에만 있고 앱을 다시 켜면 초기화된다.

### 다른 HTTP 클라이언트 (transport)

`options.transport` 에 `({url, headers, body, signal}) => Promise<{status, text}>` 를 넘긴다. 스스로 재시도·리다이렉트·타임아웃을 하지 않아야 한다(SPEC 3.6).
`signal` 의 타입은 DOM 에 기대지 않는 `AbortSignalLike` 이고 실제 값은 전역 `AbortController` 의 signal 이므로, DOM/RN `fetch` 에 넘길 때는 캐스팅한다.

```ts
import type { Transport } from 'free-llm-router';

const transport: Transport = async ({ url, headers, body, signal }) => {
  const res = await fetch(url, { method: 'POST', headers, body, signal: signal as unknown as AbortSignal });
  return { status: res.status, text: await res.text() };
};
const router2 = new Router(parseConfig(JSON.stringify(modelsJson)), { openrouter: '...' }, { transport });
```

### RN 에서 명세와 다른 점

- **리다이렉트**: 기본 transport 는 `fetch(..., { redirect: 'manual' })` 로 부르지만 RN 기기 런타임의 `fetch` 는 이 옵션을 무시하고 3xx 를 따라간다(SPEC 3.6 의 RN 예외). 실제 제공처는 리다이렉트를 쓰지 않아 실사용 차이는 없다. 테스트(Node `fetch`)에서는 3xx 가 그대로 `fatal_status` 가 되는 것을 확인한다.
- **플랫폼 자체 재시도(Android, 기기 미검증)**: RN Android 의 `fetch` 는 OkHttp 위에서 돌고, OkHttp 기본값 `retryOnConnectionFailure = true` 를 JS 에서 끌 수 없다. 연결 실패 직후 OkHttp 가 몰래 한 번 더 보낼 수 있어 "한 시도 = HTTP 요청 한 번"(SPEC 3.6)이 기기에서는 보장되지 않는다.
- **플랫폼 자체 타임아웃(iOS, 기기 미검증)**: RN iOS 의 `fetch`(NSURLSession)는 기본 약 60초 타임아웃을 JS 에서 바꿀 수 없다. `timeoutSeconds` 가 60 근처거나 더 길면 같은 멈춤이 라우터의 `timeout` 대신 `network_error` 로 나올 수 있다(둘 다 실패 +1 이라 폴백 동작은 같다). 필요하면 `xhr.timeout = timeoutMs + 5000` 을 거는 XMLHttpRequest 기반 transport 를 위처럼 넣는다.
- **시계**: 기본 `now()` 는 `Date.now()`(벽시계, SPEC 1.2). 시도 시간(`durationMs`)은 `performance.now()`.
- **토큰 추정**: `string.length`(UTF-16 코드 유닛).

## 테스트

`spec/` 의 파일을 복사하지 않고 그대로 읽는다(`FLR_SPEC_DIR` 로 바꿀 수 있음). 러너는 Jest 대신 `node:test` 다(의존성은 `typescript`·`@types/node` 뿐).

```bash
npm test                 # 빌드 + 단위 테스트 + 적합성(메모리·모의 서버 HTTP) + configCases. slow 케이스는 SKIP 표시
npm run test:slow        # slow_response_within_timeout(약 16초)까지 HTTP 모드로
npm run conformance      # 참조 러너와 같은 표 출력. 인자: -- --mode memory|http|both --case <이름> --slow
npm run typecheck        # tsc --noEmit (라이브러리는 DOM·Node 타입 없이)
OPENROUTER_API_KEY=... npm run test:live   # 실제 OpenRouter 스모크. 키가 없으면 "LIVE SKIP" 후 skip
```

HTTP 모드는 `FLR_MOCK_URL` 이 있으면 그 서버를, 없으면 `node ../spec/mock-server/server.mjs --port 0 --exit-on-stdin-close` 를 직접 띄운다. 띄우지 못하면 눈에 띄게 SKIP 을 출력한다(`npm run conformance` 는 실패로 끝남).
