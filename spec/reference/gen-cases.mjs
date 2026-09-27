// test-cases.json 생성기. 케이스를 고칠 때는 이 파일을 고치고 node gen-cases.mjs 로 다시 만든다.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../test-cases.json', import.meta.url));

const P1 = { id: 'p1', baseUrl: '{{MOCK_BASE}}/p1', keyName: 'P1_KEY' };
const P2 = { id: 'p2', baseUrl: '{{MOCK_BASE}}/p2', keyName: 'P2_KEY' };
const KEYS = { p1: 'key-p1', p2: 'key-p2' };
const BASE_SETTINGS = {
  numRetries: 3,
  allowedFails: 3,
  cooldownSeconds: 60,
  timeoutSeconds: 5,
  fallbacks: { chat: ['fast'], fast: ['chat'] },
  contextWindowFallbacks: { fast: ['chat'] },
};
const HI = { messages: [{ role: 'user', content: 'hi' }] };

// d('a') → deployment a, model m-a, provider p1, rpm 1
function d(id, o = {}) {
  return { id, provider: o.provider ?? 'p1', model: o.model ?? `m-${id}`, rpm: o.rpm ?? 1, ...(o.maxInputTokens != null ? { maxInputTokens: o.maxInputTokens } : {}), ...(o.enabled === false ? { enabled: false } : {}) };
}
function cfg(chat, fast, settings = {}, providers = [P1, P2]) {
  return {
    providers,
    groups: { chat: { deployments: chat }, fast: { deployments: fast } },
    settings: { ...BASE_SETTINGS, ...settings },
  };
}
const A = (deployment, group, outcome, status = null) => ({ deployment, group, outcome, status });
const ok = (deployment, group, attempts, extra = {}) => ({ ok: true, deployment, group, attempts, ...extra });
const err = (kind, attempts, status = null, bodyContains) => ({ ok: false, error: { kind, status, ...(bodyContains ? { bodyContains } : {}) }, attempts });
const req = (group, expect, request = HI) => ({ op: 'request', group, request, expect });
const adv = (ms) => ({ op: 'advance', ms });
const st = (states) => ({ op: 'expectState', states });
const rst = () => ({ op: 'reset' });
const zeros = (n) => Array(n).fill(0);

const E429 = { status: 429, body: { error: { message: 'Rate limit exceeded', code: 429 } } };
const E503 = { status: 503, body: { error: { message: 'Service unavailable', code: 503 } } };
const CTX400 = { status: 400, body: { error: { message: 'Input is too long for requested model.', code: 'context_length_exceeded' } } };

const cases = [];
const add = (c) => cases.push(c);

add({
  name: 'success_basic',
  description: '후보 하나, 정상 응답. 결과 메타·응답 본문·요청 경로·Authorization·body.model 확인.',
  config: cfg([d('a')], [d('f')]),
  keys: KEYS,
  rng: [0],
  responses: {},
  steps: [
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)], {
      content: 'ok:m-a',
      requests: [{ path: '/p1/chat/completions', headers: { authorization: 'Bearer key-p1' }, body: { model: 'm-a', messages: [{ role: 'user', content: 'hi' }] } }],
    })),
  ],
});

add({
  name: 'request_shape',
  description: '호출자 model 은 배포 model 로 덮어쓴다. 나머지 필드는 그대로. extraHeaders 는 그 제공처에만. baseUrl 끝 / 는 무시.',
  config: cfg([d('a')], [d('f', { provider: 'p2' })], {}, [
    { ...P1, extraHeaders: { 'HTTP-Referer': 'https://example.test/app', 'X-Title': 'flr-test' } },
    { ...P2, baseUrl: '{{MOCK_BASE}}/p2/' },
  ]),
  keys: KEYS,
  rng: [0, 0],
  responses: {},
  steps: [
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)], {
      requests: [{
        path: '/p1/chat/completions',
        headers: { authorization: 'Bearer key-p1', 'http-referer': 'https://example.test/app', 'x-title': 'flr-test' },
        body: { model: 'm-a', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 50 },
      }],
    }), { model: 'caller-model', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 50 }),
    req('fast', ok('f', 'fast', [A('f', 'fast', 'ok', 200)], {
      requests: [{ path: '/p2/chat/completions', headers: { authorization: 'Bearer key-p2' }, absentHeaders: ['x-title', 'http-referer'], body: { model: 'm-f', messages: [{ role: 'user', content: 'hi' }] } }],
    })),
  ],
});

add({
  name: 'weighted_selection',
  description: 'rpm 4/2/2 (합 8). r = rng*8, 누적합 > r 인 첫 후보. 경계값 0.5(r=4)→b, 0.75(r=6)→c.',
  config: cfg([d('a', { rpm: 4 }), d('b', { rpm: 2 }), d('c', { rpm: 2 })], [d('f')]),
  keys: KEYS,
  rng: [0, 0.49, 0.5, 0.74, 0.75, 0.999],
  responses: {},
  steps: [
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('b', 'chat', 'ok', 200)])),
    req('chat', ok('c', 'chat', [A('c', 'chat', 'ok', 200)])),
    req('chat', ok('c', 'chat', [A('c', 'chat', 'ok', 200)])),
  ],
});

add({
  name: 'reselect_weights_after_failure',
  description: '실패한 배포를 뺀 나머지로 total 을 다시 계산한다. a 실패 후 후보 b(2),c(2) 합 4, rng 0.3 → r=1.2 → b. (그룹 전체 합 8 로 계산하면 r=2.4 → c 가 되어 틀림)',
  config: cfg([d('a', { rpm: 4 }), d('b', { rpm: 2 }), d('c', { rpm: 2 })], [d('f')]),
  keys: KEYS,
  rng: [0, 0.3],
  responses: { 'm-a': [E429] },
  steps: [req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)]))],
});

add({
  name: 'retry_429_next',
  description: '429 → 실패 기록 +1, 같은 그룹 다음 후보.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [E429] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 1 }, b: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'retry_404_408',
  description: '404(모델 목록에서 빠짐), 408 은 재시도 대상.',
  config: cfg([d('a'), d('b'), d('c')], [d('f')]),
  keys: KEYS,
  rng: [0, 0, 0],
  responses: {
    'm-a': [{ status: 404, body: { error: { message: 'No endpoints found for m-a', code: 404 } } }],
    'm-b': [{ status: 408, body: { error: { message: 'Request timeout', code: 408 } } }],
  },
  steps: [
    req('chat', ok('c', 'chat', [A('a', 'chat', 'retryable_status', 404), A('b', 'chat', 'retryable_status', 408), A('c', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 1 }, b: { coolingDown: false, recentFailures: 1 }, c: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'retry_5xx',
  description: '500~599 는 재시도 대상 (520·599 포함). numRetries 6 → 그룹당 최대 7회.',
  config: cfg([d('a'), d('b'), d('c'), d('d'), d('e'), d('h'), d('g')], [d('f')], { numRetries: 6 }),
  keys: KEYS,
  rng: zeros(7),
  responses: {
    'm-a': [{ status: 500 }],
    'm-b': [{ status: 502 }],
    'm-c': [E503],
    'm-d': [{ status: 504, body: 'upstream timed out' }],
    'm-e': [{ status: 520 }],
    'm-h': [{ status: 599 }],
  },
  steps: [
    req('chat', ok('g', 'chat', [
      A('a', 'chat', 'retryable_status', 500),
      A('b', 'chat', 'retryable_status', 502),
      A('c', 'chat', 'retryable_status', 503),
      A('d', 'chat', 'retryable_status', 504),
      A('e', 'chat', 'retryable_status', 520),
      A('h', 'chat', 'retryable_status', 599),
      A('g', 'chat', 'ok', 200),
    ])),
  ],
});

add({
  name: 'retry_bad_body',
  description: 'HTTP 200 이라도 error 가 null 아닌 값으로 있거나(choices 가 있어도), choices 가 비었거나 없거나 배열이 아니거나, 본문이 JSON 객체가 아니면(최상위 배열 포함) bad_body 로 재시도. error:null 이고 choices 가 있으면 ok. numRetries 6.',
  config: cfg([d('a'), d('b'), d('c'), d('d'), d('e'), d('g'), d('h')], [d('f')], { numRetries: 6 }),
  keys: KEYS,
  rng: zeros(7),
  responses: {
    'm-a': [{ status: 200, body: { error: { message: 'Upstream error', code: 502 }, choices: [{ index: 0, message: { role: 'assistant', content: '' } }] } }],
    'm-b': [{ status: 200, body: { id: 'x', object: 'chat.completion', choices: [] } }],
    'm-c': [{ status: 200, body: '<html>not json</html>' }],
    'm-d': [{ status: 200, body: { id: 'x', object: 'chat.completion' } }],
    'm-e': [{ status: 200, body: { id: 'x', object: 'chat.completion', choices: {} } }],
    'm-g': [{ status: 200, body: '[]' }],
    'm-h': [{ status: 200, body: { id: 'x', object: 'chat.completion', error: null, choices: [{ index: 0, message: { role: 'assistant', content: 'null-error-ok' }, finish_reason: 'stop' }] } }],
  },
  steps: [
    req('chat', ok('h', 'chat', [
      A('a', 'chat', 'bad_body', 200),
      A('b', 'chat', 'bad_body', 200),
      A('c', 'chat', 'bad_body', 200),
      A('d', 'chat', 'bad_body', 200),
      A('e', 'chat', 'bad_body', 200),
      A('g', 'chat', 'bad_body', 200),
      A('h', 'chat', 'ok', 200),
    ], { content: 'null-error-ok' })),
    st({ a: { coolingDown: false, recentFailures: 1 }, b: { coolingDown: false, recentFailures: 1 }, c: { coolingDown: false, recentFailures: 1 }, d: { coolingDown: false, recentFailures: 1 } }),
  ],
});

add({
  name: 'retry_timeout',
  description: 'timeoutSeconds 0.3, a 는 1.5초 뒤 응답 → timeout(status null), 실패 기록 +1, b 로.',
  config: cfg([d('a'), d('b')], [d('f')], { timeoutSeconds: 0.3 }),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [{ status: 200, delayMs: 1500 }] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'timeout', null), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 1 } }),
  ],
});

add({
  name: 'retry_network_error',
  description: '응답 없이 연결이 끊기면 network_error(status null), 실패 기록 +1, 다음 후보.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [{ action: 'close' }] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'network_error', null), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 1 } }),
  ],
});

add({
  name: 'fatal_400',
  description: '400(컨텍스트 초과 아님)은 즉시 실패. 재시도·그룹 폴백 없음, 실패 기록 없음.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0],
  responses: { 'm-a': [{ status: 400, body: { error: { message: "Invalid value for 'temperature'", code: 'invalid_request_error' } } }] },
  steps: [
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 400)], 400, "Invalid value for 'temperature'")),
    st({ a: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'fatal_401_403',
  description: '401, 403 은 즉시 실패.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [{ status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } }, { status: 403 }] },
  steps: [
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 401)], 401, 'No auth credentials found')),
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 403)], 403, 'mock status 403')),
    st({ a: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'fatal_other_4xx',
  description: '그 외 4xx(422, 컨텍스트 문구 없는 413, 409)와 3xx 도 즉시 실패. 리다이렉트(302 + Location)는 따라가지 않는다.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0, 0, 0, 0],
  responses: {
    'm-a': [
      { status: 422 },
      { status: 413, body: { error: { message: 'Request entity too large' } } },
      { status: 409 },
      { status: 302, headers: { Location: '/p1/chat/completions' }, body: 'moved' },
    ],
  },
  steps: [
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 422)], 422)),
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 413)], 413)),
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 409)], 409)),
    req('chat', err('non_retryable', [A('a', 'chat', 'fatal_status', 302)], 302, 'moved')),
  ],
});

add({
  name: 'fatal_after_retryable',
  description: '재시도 중 만난 401 도 즉시 실패. 에러의 시도 목록에 앞선 429 가 남는다.',
  config: cfg([d('a'), d('b'), d('c')], [d('f')]),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [E429], 'm-b': [{ status: 401 }] },
  steps: [
    req('chat', err('non_retryable', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'fatal_status', 401)], 401)),
    st({ a: { coolingDown: false, recentFailures: 1 }, b: { coolingDown: false, recentFailures: 0 }, c: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'cooldown_after_allowed_fails_and_recovery',
  description: 'a 가 3번 실패하면 60초 쿨다운(후보 제외, 실패 기록 비움). 59.999초엔 아직, 60초 정각에 복귀.',
  config: cfg([d('a')], [d('f')]),
  keys: KEYS,
  rng: zeros(9),
  responses: { 'm-a': [E429, E429, E429] },
  steps: [
    req('chat', ok('f', 'fast', [A('a', 'chat', 'retryable_status', 429), A('f', 'fast', 'ok', 200)])),
    req('chat', ok('f', 'fast', [A('a', 'chat', 'retryable_status', 429), A('f', 'fast', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 2 } }),
    req('chat', ok('f', 'fast', [A('a', 'chat', 'retryable_status', 429), A('f', 'fast', 'ok', 200)])),
    st({ a: { coolingDown: true, cooldownUntilMs: 1060000, recentFailures: 0 }, f: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 } }),
    req('chat', ok('f', 'fast', [A('f', 'fast', 'ok', 200)])),
    adv(59999),
    st({ a: { coolingDown: true, cooldownUntilMs: 1060000, recentFailures: 0 } }),
    req('chat', ok('f', 'fast', [A('f', 'fast', 'ok', 200)])),
    adv(1),
    st({ a: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 } }),
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
  ],
});

add({
  name: 'failure_window_expiry',
  description: '실패는 최근 60초(now - t < 60000ms) 안의 것만 센다. t=0 실패는 t=60000 에서 빠진다.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(8),
  responses: { 'm-a': [E503, E503, E503, E503] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 503), A('b', 'chat', 'ok', 200)])),
    adv(30000),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 503), A('b', 'chat', 'ok', 200)])),
    adv(30000),
    st({ a: { coolingDown: false, recentFailures: 1 } }),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 503), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 2 } }),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 503), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: true, recentFailures: 0 } }),
  ],
});

add({
  name: 'success_does_not_reset_failures',
  description: '성공해도 실패 기록은 지우지 않는다. 실패-성공-실패-실패 → 쿨다운.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(7),
  responses: { 'm-a': [E429, { status: 200 }, E429, E429] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 2 } }),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: true, recentFailures: 0 } }),
  ],
});

add({
  name: 'retry_limit_then_group_fallback',
  description: '그룹당 최대 1+numRetries=4회. chat 4회 실패(e 는 시도 안 함) → fast 로, fast 는 다시 4회까지.',
  config: cfg([d('a'), d('b'), d('c'), d('d'), d('e')], [d('f'), d('g')]),
  keys: KEYS,
  rng: zeros(6),
  responses: { 'm-a': [E429], 'm-b': [E429], 'm-c': [E503], 'm-d': [E429], 'm-f': [E429] },
  steps: [
    req('chat', ok('g', 'fast', [
      A('a', 'chat', 'retryable_status', 429),
      A('b', 'chat', 'retryable_status', 429),
      A('c', 'chat', 'retryable_status', 503),
      A('d', 'chat', 'retryable_status', 429),
      A('f', 'fast', 'retryable_status', 429),
      A('g', 'fast', 'ok', 200),
    ])),
    st({ e: { coolingDown: false, recentFailures: 0 }, d: { coolingDown: false, recentFailures: 1 } }),
  ],
});

add({
  name: 'group_fallback_no_revisit',
  description: 'chat 소진 → fast 소진 → fast 의 폴백 chat 은 이미 방문 → all_failed. 시도 목록은 두 그룹 전부.',
  config: cfg([d('a'), d('b')], [d('f'), d('g')]),
  keys: KEYS,
  rng: zeros(4),
  responses: { 'm-a': [E503], 'm-b': [E429], 'm-f': [E429], 'm-g': [{ status: 502 }] },
  steps: [
    req('chat', err('all_failed', [
      A('a', 'chat', 'retryable_status', 503),
      A('b', 'chat', 'retryable_status', 429),
      A('f', 'fast', 'retryable_status', 429),
      A('g', 'fast', 'retryable_status', 502),
    ])),
  ],
});

add({
  name: 'fast_context_to_chat',
  description: 'fast 에서 컨텍스트 초과(400 code, 413 metadata 문구) → 실패 기록 없이 다음 후보 → fast 가 컨텍스트 사유로 끝남 → contextWindowFallbacks 의 chat.',
  config: cfg([d('c')], [d('f'), d('g')]),
  keys: KEYS,
  rng: zeros(3),
  responses: {
    'm-f': [{ status: 400, body: { error: { message: 'Input is too long for requested model.', code: 'context_length_exceeded' } } }],
    'm-g': [{ status: 413, body: { error: { message: 'Provider returned error', code: 413, metadata: { raw: '{"error":"Request has Too Many Tokens"}' } } } }],
  },
  steps: [
    req('fast', ok('c', 'chat', [
      A('f', 'fast', 'context_exceeded', 400),
      A('g', 'fast', 'context_exceeded', 413),
      A('c', 'chat', 'ok', 200),
    ])),
    st({ f: { coolingDown: false, recentFailures: 0 }, g: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'chat_context_without_context_fallback',
  description: 'chat 이 컨텍스트 사유로 끝났는데 contextWindowFallbacks.chat 이 없음 → 일반 fallbacks 로 가지 않고 context_window_exceeded.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(2),
  responses: {
    'm-a': [{ status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens." } } }],
    'm-b': [{ status: 400, body: 'Context Length Exceeded' }],
  },
  steps: [
    req('chat', err('context_window_exceeded', [A('a', 'chat', 'context_exceeded', 400), A('b', 'chat', 'context_exceeded', 400)])),
    st({ a: { coolingDown: false, recentFailures: 0 }, b: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'group_end_reason_is_last_attempt',
  description: '그룹 종료 사유 = 그 그룹 마지막 시도의 결과. (1) 429 후 context → contextWindowFallbacks(chat). (2) context 후 429 → fallbacks.fast(비어 있음) → all_failed.',
  config: cfg([d('c')], [d('f'), d('g')], { fallbacks: { chat: ['fast'], fast: [] } }),
  keys: KEYS,
  rng: zeros(5),
  responses: {
    'm-f': [E429, { status: 400, body: { error: { code: 'context_length_exceeded', message: 'too long' } } }],
    'm-g': [{ status: 400, body: { error: { message: 'context_length_exceeded' } } }, E429],
  },
  steps: [
    req('fast', ok('c', 'chat', [
      A('f', 'fast', 'retryable_status', 429),
      A('g', 'fast', 'context_exceeded', 400),
      A('c', 'chat', 'ok', 200),
    ])),
    req('fast', err('all_failed', [
      A('f', 'fast', 'context_exceeded', 400),
      A('g', 'fast', 'retryable_status', 429),
    ])),
  ],
});

const text = (n) => 'x'.repeat(n);
add({
  name: 'max_input_tokens_exclusion',
  description: '토큰 추정 ceil(글자수/4). 40자=10토큰 → maxInputTokens 10 인 f 포함, 41자=11토큰 → f 제외.',
  config: cfg([d('c')], [d('f', { maxInputTokens: 10 }), d('g')]),
  keys: KEYS,
  rng: [0, 0],
  responses: {},
  steps: [
    req('fast', ok('f', 'fast', [A('f', 'fast', 'ok', 200)]), { messages: [{ role: 'system', content: text(20) }, { role: 'user', content: text(20) }] }),
    req('fast', ok('g', 'fast', [A('g', 'fast', 'ok', 200)]), { messages: [{ role: 'system', content: text(20) }, { role: 'user', content: text(21) }] }),
  ],
});

add({
  name: 'token_estimate_utf16_and_parts',
  description: '길이 = UTF-16 코드 유닛. content 배열이면 text 필드만, null 은 0. (1) "ab"+"😀"(2)+"😀한글"(4)+"x" = 9 → 3토큰 > 2 → f 제외 (코드 포인트로 세면 7 → 2토큰이 되어 틀림). (2) "abcd"+"한글한글" = 8 → 2토큰 → f 포함.',
  config: cfg([d('c')], [d('f', { maxInputTokens: 2 }), d('g')]),
  keys: KEYS,
  rng: [0, 0],
  responses: {},
  steps: [
    req('fast', ok('g', 'fast', [A('g', 'fast', 'ok', 200)]), {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } }, { type: 'text', text: '😀' }] },
        { role: 'assistant', content: null },
        { role: 'user', content: '😀한글' },
        { role: 'user', content: 'x' },
      ],
    }),
    req('fast', ok('f', 'fast', [A('f', 'fast', 'ok', 200)]), {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } }] },
        { role: 'assistant', content: null },
        { role: 'user', content: '한글한글' },
      ],
    }),
  ],
});

add({
  name: 'fast_all_token_excluded_to_chat',
  description: 'fast 전원이 maxInputTokens 로 빠져 시도 0회 → 컨텍스트 사유 → contextWindowFallbacks(chat). (fallbacks.fast 는 비워 둠)',
  config: cfg([d('c')], [d('f', { maxInputTokens: 5 }), d('g', { maxInputTokens: 5 })], { fallbacks: { chat: ['fast'], fast: [] } }),
  keys: KEYS,
  rng: [0],
  responses: {},
  steps: [req('fast', ok('c', 'chat', [A('c', 'chat', 'ok', 200)]), { messages: [{ role: 'user', content: text(40) }] })],
});

add({
  name: 'missing_key_excluded',
  description: '키가 없거나 빈 문자열인 제공처의 배포는 후보에서 뺀다 (rpm 이 커도).',
  config: cfg([d('a', { provider: 'p2', rpm: 100 }), d('x', { provider: 'p3', rpm: 100 }), d('b')], [d('f')], {}, [
    P1,
    P2,
    { id: 'p3', baseUrl: '{{MOCK_BASE}}/p3', keyName: 'P3_KEY' },
  ]),
  keys: { p1: 'key-p1', p3: '' },
  rng: [0],
  responses: {},
  steps: [
    req('chat', ok('b', 'chat', [A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 }, x: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 } }),
  ],
});

add({
  name: 'disabled_excluded',
  description: 'enabled:false 배포는 후보에서 뺀다. deploymentStates 에는 비활성 배포도 나온다.',
  config: cfg([d('a', { rpm: 100, enabled: false }), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0],
  responses: {},
  steps: [
    req('chat', ok('b', 'chat', [A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 } }),
  ],
});

add({
  name: 'no_candidates_all_failed',
  description: '모든 그룹에 후보가 없으면(키 없음) 시도 0회로 all_failed. rng 도 호출하지 않는다.',
  config: cfg([d('a', { provider: 'p2' })], [d('f', { provider: 'p2' })]),
  keys: { p1: 'key-p1' },
  rng: [],
  responses: {},
  steps: [req('chat', err('all_failed', []))],
});

add({
  name: 'invalid_request',
  description: '없는 그룹, messages 누락, stream:true 는 invalid_request (시도 0회).',
  config: cfg([d('a')], [d('f')]),
  keys: KEYS,
  rng: [],
  responses: {},
  steps: [
    req('slow', err('invalid_request', [])),
    req('chat', err('invalid_request', []), { prompt: 'hi' }),
    req('chat', err('invalid_request', []), { messages: [{ role: 'user', content: 'hi' }], stream: true }),
  ],
});

add({
  name: 'cooled_group_falls_back',
  description: 'allowedFails 1. chat 두 배포가 한 번씩 실패해 쿨다운 → 다음 요청은 chat 시도 0회(retryable 사유) → 일반 fallbacks 로 fast.',
  config: cfg([d('a'), d('b')], [d('f')], { allowedFails: 1 }),
  keys: KEYS,
  rng: zeros(4),
  responses: { 'm-a': [E429], 'm-b': [E429] },
  steps: [
    req('chat', ok('f', 'fast', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'retryable_status', 429), A('f', 'fast', 'ok', 200)])),
    st({ a: { coolingDown: true, recentFailures: 0 }, b: { coolingDown: true, recentFailures: 0 } }),
    req('chat', ok('f', 'fast', [A('f', 'fast', 'ok', 200)])),
  ],
});


add({
  name: 'no_revisit_with_untried_deployment',
  description: '그룹 재방문 금지를 결과로 확인. chat 은 시도 한도 4회로 끝나 e 가 남아 있다. fast 소진 후 fallbacks.fast=[chat] 이지만 이미 방문 → all_failed. (재방문하면 e 가 성공해 갈린다)',
  config: cfg([d('a'), d('b'), d('c'), d('d'), d('e')], [d('f')]),
  keys: KEYS,
  rng: zeros(5),
  responses: { 'm-a': [E429], 'm-b': [E429], 'm-c': [E429], 'm-d': [E429], 'm-f': [E429] },
  steps: [
    req('chat', err('all_failed', [
      A('a', 'chat', 'retryable_status', 429),
      A('b', 'chat', 'retryable_status', 429),
      A('c', 'chat', 'retryable_status', 429),
      A('d', 'chat', 'retryable_status', 429),
      A('f', 'fast', 'retryable_status', 429),
    ])),
    st({ e: { coolingDown: false, recentFailures: 0 } }),
  ],
});

add({
  name: 'fallback_queue_fifo',
  description: '그룹 폴백은 대기열(FIFO). fallbacks.chat=[fast, big]: chat 소진 → fast 먼저. 두 번째 요청에서 fast 도 소진 → big.',
  config: {
    providers: [P1, P2],
    groups: { chat: { deployments: [d('a')] }, fast: { deployments: [d('f')] }, big: { deployments: [d('z')] } },
    settings: { ...BASE_SETTINGS, fallbacks: { chat: ['fast', 'big'], fast: ['chat'], big: [] }, contextWindowFallbacks: {} },
  },
  keys: KEYS,
  rng: zeros(5),
  responses: { 'm-a': [E429, E429], 'm-f': [{ status: 200 }, E429] },
  steps: [
    req('chat', ok('f', 'fast', [A('a', 'chat', 'retryable_status', 429), A('f', 'fast', 'ok', 200)])),
    req('chat', ok('z', 'big', [A('a', 'chat', 'retryable_status', 429), A('f', 'fast', 'retryable_status', 429), A('z', 'big', 'ok', 200)])),
  ],
});

add({
  name: 'context_attempts_count_toward_limit',
  description: '컨텍스트 초과 시도도 그룹 시도 한도(1+numRetries=4)에 든다. fast 5개가 모두 컨텍스트 초과 → 4회 뒤 contextWindowFallbacks 의 chat. j 는 시도하지 않는다.',
  config: cfg([d('c')], [d('f'), d('g'), d('h'), d('i'), d('j')]),
  keys: KEYS,
  rng: zeros(5),
  responses: Object.fromEntries(['f', 'g', 'h', 'i', 'j'].map((x) => [`m-${x}`, [CTX400]])),
  steps: [
    req('fast', ok('c', 'chat', [
      A('f', 'fast', 'context_exceeded', 400),
      A('g', 'fast', 'context_exceeded', 400),
      A('h', 'fast', 'context_exceeded', 400),
      A('i', 'fast', 'context_exceeded', 400),
      A('c', 'chat', 'ok', 200),
    ])),
  ],
});

add({
  name: 'mixed_reasons_all_failed',
  description: '방문 그룹의 사유가 섞이면 all_failed. fast 컨텍스트 초과 → chat 은 429·503 으로 소진(retryable) → all_failed (context_window_exceeded 아님).',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(3),
  responses: { 'm-f': [CTX400], 'm-a': [E429], 'm-b': [E503] },
  steps: [
    req('fast', err('all_failed', [
      A('f', 'fast', 'context_exceeded', 400),
      A('a', 'chat', 'retryable_status', 429),
      A('b', 'chat', 'retryable_status', 503),
    ])),
  ],
});

add({
  name: 'start_exclusion_token_wins_over_cooldown',
  description: '시도 0회 그룹에서 토큰 한도로 빠진 배포가 하나라도 있으면(다른 배포가 쿨다운으로 빠졌어도) context 사유. allowedFails 1, fallbacks.fast 는 비움.',
  config: cfg([d('c')], [d('f'), d('g', { maxInputTokens: 5 })], { allowedFails: 1, fallbacks: { chat: ['fast'], fast: [] } }),
  keys: KEYS,
  rng: zeros(3),
  responses: { 'm-f': [E429] },
  steps: [
    req('fast', ok('g', 'fast', [A('f', 'fast', 'retryable_status', 429), A('g', 'fast', 'ok', 200)])),
    st({ f: { coolingDown: true, recentFailures: 0 } }),
    req('fast', ok('c', 'chat', [A('c', 'chat', 'ok', 200)]), { messages: [{ role: 'user', content: text(40) }] }),
  ],
});

add({
  name: 'cooldown_seconds_scales_window',
  description: 'cooldownSeconds 10 이면 실패 창과 쿨다운 길이 모두 10초. 실패 2회 → 10초 뒤 0회. 3연속 실패 → 쿨다운(1,020,000까지) → 9,999ms 뒤 아직, 1ms 더 지나면 복귀.',
  config: cfg([d('a'), d('b')], [d('f')], { cooldownSeconds: 10 }),
  keys: KEYS,
  rng: zeros(11),
  responses: { 'm-a': [E429, E429, E429, E429, E429] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 2 } }),
    adv(10000),
    st({ a: { coolingDown: false, recentFailures: 0 } }),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: true, cooldownUntilMs: 1020000, recentFailures: 0 } }),
    adv(9999),
    st({ a: { coolingDown: true, cooldownUntilMs: 1020000 } }),
    adv(1),
    st({ a: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 } }),
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
  ],
});
add({
  name: 'reset_state_clears_cooldown',
  description: 'a 3연속 실패 → 쿨다운. reset 뒤 곧바로(시계 그대로) a 가 후보로 돌아오고 실패 기록 0. 설정의 다른 배포 상태도 비어 있다.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(7),
  responses: { 'm-a': [E429, E429, E429] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    req('chat', ok('b', 'chat', [A('a', 'chat', 'retryable_status', 429), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: true, cooldownUntilMs: 1060000, recentFailures: 0 } }),
    rst(),
    st({ a: { coolingDown: false, cooldownUntilMs: null, recentFailures: 0 }, b: { coolingDown: false, recentFailures: 0 }, f: { coolingDown: false, recentFailures: 0 } }),
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
  ],
});

add({
  name: 'context_pattern_ascii_case_fold',
  description: '컨텍스트 문구 검사는 ASCII A–Z 만 소문자로 바꾼다(로캘 무관). (1) "MAXIMUM CONTEXT" 대문자 → context_exceeded. (2) 켈빈 기호 K(U+212A)가 든 "TOO MANY TO\\u212AENS" 는 ASCII 소문자화로는 "too many tokens" 가 되지 않으므로 413 → fatal_status.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: zeros(2),
  responses: {
    'm-a': [{ status: 400, body: { error: { message: "THIS MODEL'S MAXIMUM CONTEXT LENGTH IS 8192 TOKENS" } } }],
    'm-b': [{ status: 413, body: 'TOO MANY TOKENS' }],
  },
  steps: [
    req('chat', err('non_retryable', [A('a', 'chat', 'context_exceeded', 400), A('b', 'chat', 'fatal_status', 413)], 413, 'TOO MANY')),
  ],
});

add({
  name: 'timeout_during_body',
  description: '타임아웃은 본문 수신 완료까지 잰다. a 는 헤더와 본문 절반을 바로 보내고 나머지를 1.5초 뒤에 보낸다(timeoutSeconds 0.3) → timeout.',
  config: cfg([d('a'), d('b')], [d('f')], { timeoutSeconds: 0.3 }),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [{ status: 200, bodyDelayMs: 1500 }] },
  steps: [
    req('chat', ok('b', 'chat', [A('a', 'chat', 'timeout', null), A('b', 'chat', 'ok', 200)])),
    st({ a: { coolingDown: false, recentFailures: 1 } }),
  ],
});

add({
  name: 'cancel_in_flight',
  description: '호출자 취소. (1) a 가 3초 뒤 응답하는 중 200ms 에 취소 → 언어 네이티브 취소 예외(RouterError 아님), 실패 기록 없음. (2) 이미 취소된 상태로 호출 → 요청·rng 없이 취소 예외. (3) 이후 정상 요청은 a 로 성공.',
  config: cfg([d('a'), d('b')], [d('f')]),
  keys: KEYS,
  rng: [0, 0],
  responses: { 'm-a': [{ status: 200, delayMs: 3000 }] },
  steps: [
    { op: 'request', group: 'chat', request: HI, cancelAfterMs: 200, expect: { cancelled: true, requests: [{ path: '/p1/chat/completions' }] } },
    st({ a: { coolingDown: false, recentFailures: 0 }, b: { coolingDown: false, recentFailures: 0 } }),
    { op: 'request', group: 'chat', request: HI, cancelAfterMs: 0, expect: { cancelled: true, requests: [] } },
    req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)])),
  ],
});

add({
  name: 'slow_response_within_timeout',
  tags: ['slow'],
  description: '[slow, http 전용] timeoutSeconds 20, 응답 16초. 플랫폼 HTTP 클라이언트 자체 타임아웃(OkHttp 기본 10초, Ktor CIO 15초)이 라우터보다 먼저 터지면 network_error 가 되어 실패한다.',
  config: cfg([d('a')], [d('f')], { timeoutSeconds: 20 }),
  keys: KEYS,
  rng: [0],
  responses: { 'm-a': [{ status: 200, delayMs: 16000 }] },
  steps: [req('chat', ok('a', 'chat', [A('a', 'chat', 'ok', 200)]))],
});

// ── parseConfig 수용/거부 (SPEC.md 6절) ──────────────
const BASE_CFG = {
  providers: [{ id: 'p1', baseUrl: 'https://example.test/p1' }],
  groups: { chat: { deployments: [{ id: 'a', provider: 'p1', model: 'm-a', rpm: 1 }] } },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
// f(cfg) 로 고친 설정을 JSON 문자열로
const mk = (f) => {
  const c = clone(BASE_CFG);
  const r = f(c);
  return JSON.stringify(r === undefined ? c : r);
};
const dep0 = (c) => c.groups.chat.deployments[0];
const configCases = [];
const cc = (name, expect, json, description) => configCases.push({ name, description, expect, json });

cc('ok_minimal', 'ok', mk(() => {}), '필수 필드만.');
cc('ok_unknown_keys_every_level', 'ok', mk((c) => {
  c.$schema = './models.schema.json'; c.description = 'x'; c.updated = '2026-09-27'; c.futureTopLevel = { a: 1 };
  c.providers[0].note = 'n'; c.providers[0].futureProviderKey = true;
  c.groups.chat.description = '일반 대화'; c.groups.chat.futureGroupKey = [1];
  Object.assign(dep0(c), { note: 42, tpm: 7000 });
  c.settings = { numRetries: 3, futureSetting: 'x' };
}), '모든 레벨의 모르는 키(그룹 description, 배포 tpm 등)와 note(타입 무관)는 무시.');
cc('ok_integer_with_zero_fraction', 'ok', mk(() => {}).replace('"rpm":1', '"rpm":4.0').replace('"groups"', '"settings":{"numRetries":3.0,"allowedFails":3.0},"groups"'), '정수 필드에 4.0 처럼 소수부가 0 인 수는 정수로 인정.');
cc('ok_optional_null_is_absent', 'ok', mk((c) => {
  c.version = null; c.providers[0].keyName = null; c.providers[0].extraHeaders = null;
  Object.assign(dep0(c), { maxInputTokens: null, enabled: null });
  c.settings = { numRetries: null, fallbacks: null, contextWindowFallbacks: null };
}), '선택 필드가 null 이면 없는 것(기본값)으로 본다.');
cc('ok_full_valid', 'ok', mk((c) => {
  c.version = 1; c.providers[0].keyName = 'P1_KEY'; c.providers[0].extraHeaders = { 'X-Title': 't', 'HTTP-Referer': 'https://example.test' };
  Object.assign(dep0(c), { maxInputTokens: 6000, enabled: false });
  c.groups.fast = { deployments: [] };
  c.settings = { numRetries: 0, allowedFails: 1, cooldownSeconds: 1.5, timeoutSeconds: 0.3, fallbacks: { chat: ['fast'], fast: ['chat'] }, contextWindowFallbacks: { fast: ['chat'] } };
}), '모든 필드를 쓴 유효한 설정. 배포가 없는 그룹도 허용.');
cc('err_invalid_json', 'config_error', '{"providers": [', 'JSON 문법 오류.');
cc('err_top_level_array', 'config_error', '[]', '최상위가 객체가 아님.');
cc('err_version_2', 'config_error', mk((c) => { c.version = 2; }), 'version 은 있으면 1.');
cc('err_providers_missing', 'config_error', mk((c) => { delete c.providers; }), 'providers 누락.');
cc('err_provider_id_missing', 'config_error', mk((c) => { delete c.providers[0].id; }), 'provider.id 누락.');
cc('err_provider_base_url_missing', 'config_error', mk((c) => { delete c.providers[0].baseUrl; }), 'provider.baseUrl 누락.');
cc('err_provider_base_url_not_string', 'config_error', mk((c) => { c.providers[0].baseUrl = 1; }), 'baseUrl 타입 오류.');
cc('err_duplicate_provider', 'config_error', mk((c) => { c.providers.push({ id: 'p1', baseUrl: 'https://example.test/x' }); }), '제공처 id 중복.');
cc('err_key_name_not_string', 'config_error', mk((c) => { c.providers[0].keyName = 1; }), 'keyName 타입 오류.');
cc('err_extra_header_authorization', 'config_error', mk((c) => { c.providers[0].extraHeaders = { authorization: 'Bearer x' }; }), 'extraHeaders 에 Authorization(대소문자 무시).');
cc('err_extra_header_content_type', 'config_error', mk((c) => { c.providers[0].extraHeaders = { 'Content-Type': 'text/plain' }; }), 'extraHeaders 에 Content-Type.');
cc('err_extra_header_value_not_string', 'config_error', mk((c) => { c.providers[0].extraHeaders = { 'X-Title': 1 }; }), 'extraHeaders 값 타입 오류.');
cc('err_groups_missing', 'config_error', mk((c) => { delete c.groups; }), 'groups 누락.');
cc('err_deployments_not_array', 'config_error', mk((c) => { c.groups.chat.deployments = {}; }), 'deployments 가 배열 아님.');
cc('err_deployment_id_missing', 'config_error', mk((c) => { delete dep0(c).id; }), '배포 id 누락.');
cc('err_duplicate_deployment_across_groups', 'config_error', mk((c) => { c.groups.fast = { deployments: [{ id: 'a', provider: 'p1', model: 'm-x', rpm: 1 }] }; }), '배포 id 중복(그룹 간).');
cc('err_unknown_provider', 'config_error', mk((c) => { dep0(c).provider = 'nope'; }), '없는 제공처 참조.');
cc('err_provider_ref_missing', 'config_error', mk((c) => { delete dep0(c).provider; }), '배포 provider 누락.');
cc('err_model_missing', 'config_error', mk((c) => { delete dep0(c).model; }), 'model 누락.');
cc('err_model_empty', 'config_error', mk((c) => { dep0(c).model = ''; }), 'model 빈 문자열.');
cc('err_rpm_missing', 'config_error', mk((c) => { delete dep0(c).rpm; }), 'rpm 누락.');
cc('err_rpm_null', 'config_error', mk((c) => { dep0(c).rpm = null; }), '필수 필드가 null.');
cc('err_rpm_zero', 'config_error', mk((c) => { dep0(c).rpm = 0; }), 'rpm < 1.');
cc('err_rpm_fraction', 'config_error', mk((c) => { dep0(c).rpm = 4.5; }), 'rpm 소수.');
cc('err_rpm_string', 'config_error', mk((c) => { dep0(c).rpm = '4'; }), 'rpm 문자열.');
cc('err_rpm_too_large', 'config_error', mk((c) => { dep0(c).rpm = 2147483648; }), '정수 필드 상한 2147483647 초과.');
cc('err_max_input_tokens_zero', 'config_error', mk((c) => { dep0(c).maxInputTokens = 0; }), 'maxInputTokens < 1.');
cc('err_enabled_string', 'config_error', mk((c) => { dep0(c).enabled = 'yes'; }), 'enabled 타입 오류.');
cc('err_settings_not_object', 'config_error', mk((c) => { c.settings = []; }), 'settings 가 객체 아님.');
cc('err_num_retries_negative', 'config_error', mk((c) => { c.settings = { numRetries: -1 }; }), 'numRetries < 0.');
cc('err_allowed_fails_zero', 'config_error', mk((c) => { c.settings = { allowedFails: 0 }; }), 'allowedFails < 1.');
cc('err_cooldown_zero', 'config_error', mk((c) => { c.settings = { cooldownSeconds: 0 }; }), 'cooldownSeconds <= 0.');
cc('err_timeout_negative', 'config_error', mk((c) => { c.settings = { timeoutSeconds: -1 }; }), 'timeoutSeconds <= 0.');
cc('err_timeout_string', 'config_error', mk((c) => { c.settings = { timeoutSeconds: '60' }; }), 'timeoutSeconds 문자열.');
cc('err_fallback_unknown_target', 'config_error', mk((c) => { c.settings = { fallbacks: { chat: ['nope'] } }; }), 'fallbacks 에 없는 그룹(대상).');
cc('err_fallback_unknown_source', 'config_error', mk((c) => { c.settings = { contextWindowFallbacks: { nope: ['chat'] } }; }), 'contextWindowFallbacks 에 없는 그룹(키).');
cc('err_fallbacks_not_array', 'config_error', mk((c) => { c.settings = { fallbacks: { chat: 'chat' } }; }), 'fallbacks 값이 배열 아님.');

writeFileSync(
  OUT,
  JSON.stringify(
    {
      version: 1,
      description: 'free-llm-router 적합성 시나리오. 형식과 러너 규약은 SPEC.md 8절.',
      clockStartMs: 1000000,
      mockBasePlaceholder: '{{MOCK_BASE}}',
      cases,
      configCases,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${cases.length} cases, ${configCases.length} config cases`);
