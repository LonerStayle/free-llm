// 적합성 시나리오가 다루지 않는 RN/TS 고유 동작 단위 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AbortError,
  ConfigError,
  Router,
  RouterError,
  asciiLower,
  estimateTokens,
  fetchTransport,
  parseConfig,
} from 'free-llm-router';
import type { AbortSignalLike, FetchInit, Transport } from 'free-llm-router';
import { SPEC_DIR } from './support/conformance.js';

const baseConfig = (settings: Record<string, unknown> = {}, groups?: Record<string, unknown>) => ({
  providers: [{ id: 'p1', baseUrl: 'http://mock.invalid/p1/' }],
  groups: groups ?? {
    chat: { deployments: [{ id: 'a', provider: 'p1', model: 'm-a', rpm: 1 }] },
  },
  settings,
});
const okBody = (model: string) =>
  JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `ok:${model}` } }] });
const hi = { messages: [{ role: 'user', content: 'hi' }] };

/** delayMs 뒤 200. signal 이 끊기면 예외 (fetch 처럼). */
function slowTransport(delayMs: number, calls: string[] = []): Transport {
  return ({ body, signal }) =>
    new Promise((resolve, reject) => {
      const model = JSON.parse(body).model as string;
      calls.push(model);
      const t = setTimeout(() => resolve({ status: 200, text: okBody(model) }), delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted by router'));
      });
    });
}

test('spec/models.json 이 parseConfig 를 통과한다', () => {
  const cfg = parseConfig(readFileSync(join(SPEC_DIR, 'models.json'), 'utf8'));
  assert.ok(cfg.groups.has('chat') && cfg.groups.has('fast'));
  assert.deepEqual(cfg.settings.fallbacks.get('chat'), ['fast']);
});

test('토큰 추정은 UTF-16 코드 유닛(string.length) 기준', () => {
  // '😀' 는 UTF-16 2 유닛, 'é' 1 유닛 → 3 유닛 → ceil(3/4) = 1
  assert.equal(estimateTokens({ messages: [{ content: '😀é' }] }), 1);
  assert.equal(estimateTokens({ messages: [{ content: [{ type: 'text', text: 'abcd' }, { type: 'image_url' }, { text: 'e' }] }] }), 2);
  assert.equal(estimateTokens({ messages: [null, { content: null }, { role: 'user' }] }), 0);
});

test('asciiLower 는 ASCII 만 바꾼다 (켈빈 기호·터키어 İ 그대로)', () => {
  assert.equal(asciiLower('Context LENGTH K İ'), 'context length K İ');
});

test('취소: signal.reason 이 없는 신호(Hermes 폴리필)면 AbortError 를 던진다', async () => {
  const listeners: (() => void)[] = [];
  let aborted = false;
  const signal: AbortSignalLike = {
    get aborted() {
      return aborted;
    },
    addEventListener: (_, l) => void listeners.push(l),
    removeEventListener: () => {},
  };
  const calls: string[] = [];
  const router = new Router(baseConfig(), { p1: 'k' }, { transport: slowTransport(2000, calls) });
  const p = router.route('chat', hi, { signal });
  setTimeout(() => {
    aborted = true;
    listeners.forEach((l) => l());
  }, 50);
  const t0 = Date.now();
  await assert.rejects(p, (e: unknown) => e instanceof AbortError && e.name === 'AbortError' && !(e instanceof RouterError));
  assert.ok(Date.now() - t0 < 1000, 'cancellation must not wait for the response');
  assert.deepEqual(calls, ['m-a']);
  assert.equal(router.deploymentStates()['a']!.recentFailures, 0);
});

test('취소: abort(reason) 의 reason 을 그대로 던지고, 이미 취소면 요청을 보내지 않는다', async () => {
  const calls: string[] = [];
  const router = new Router(baseConfig(), { p1: 'k' }, { transport: slowTransport(10, calls), rng: () => assert.fail('rng used') });
  const reason = new Error('app went to background');
  const ctrl = new AbortController();
  ctrl.abort(reason);
  await assert.rejects(router.route('chat', hi, { signal: ctrl.signal }), (e) => e === reason);
  assert.deepEqual(calls, []);
});

test('invalid_request 는 취소 검사보다 먼저, 시도 없이', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const router = new Router(baseConfig(), { p1: 'k' }, { transport: slowTransport(10) });
  for (const [group, req] of [
    ['nope', hi],
    ['toString', hi],
    ['chat', { messages: 'x' }],
    ['chat', { ...hi, stream: true }],
  ] as const) {
    await assert.rejects(router.route(group, req as never, { signal: ctrl.signal }), (e: unknown) => {
      return e instanceof RouterError && e.kind === 'invalid_request' && e.attempts.length === 0 && e.status === null && e.body === null;
    });
  }
});

test('프로토타입 이름 그룹(constructor)도 일반 그룹처럼 동작', async () => {
  const cfg = baseConfig(
    { fallbacks: { constructor: ['chat'] } },
    {
      constructor: { deployments: [{ id: 'c', provider: 'p1', model: 'm-c', rpm: 1 }] },
      chat: { deployments: [{ id: 'a', provider: 'p1', model: 'm-a', rpm: 1 }] },
    },
  );
  const transport: Transport = async ({ body }) => {
    const model = JSON.parse(body).model as string;
    return model === 'm-c' ? { status: 503, text: '{}' } : { status: 200, text: okBody(model) };
  };
  const router = new Router(cfg, new Map([['p1', 'k']]), { transport, rng: () => 0 });
  const r = await router.route('constructor', hi);
  assert.equal(r.group, 'chat');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['retryable_status', 'ok']);
  // 'chat' 에는 fallbacks 가 없다. 상속된 Object.prototype 값을 폴백 목록으로 읽으면 안 된다
  assert.throws(() => parseConfig(JSON.stringify(baseConfig({ fallbacks: { toString: ['chat'] } }))), ConfigError);
});

test('Router 는 원시 설정 객체도 받고, 잘못되면 ConfigError', () => {
  assert.throws(() => new Router({ providers: 'x', groups: {} }, {}), ConfigError);
  const r = new Router(baseConfig(), { p1: 'k' });
  assert.deepEqual(Object.keys(r.deploymentStates()), ['a']);
});

test('timeoutSeconds 가 setTimeout 한계(2^31-1ms)를 넘어도 곧바로 타임아웃하지 않는다', async () => {
  const router = new Router(baseConfig({ timeoutSeconds: 3_000_000 }), { p1: 'k' }, { transport: slowTransport(30), rng: () => 0 });
  const r = await router.route('chat', hi);
  assert.equal(r.attempts[0]!.outcome, 'ok');
  assert.ok(r.attempts[0]!.durationMs >= 0);
});

test('전역 AbortController 가 없어도 타임아웃이 transport 를 끊는다', async () => {
  const g = globalThis as { AbortController?: unknown };
  const saved = g.AbortController;
  delete g.AbortController;
  try {
    let sawAbort = false;
    const transport: Transport = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });
    const router = new Router(baseConfig({ timeoutSeconds: 0.05, numRetries: 0 }), { p1: 'k' }, { transport, rng: () => 0 });
    await assert.rejects(router.route('chat', hi), (e: unknown) => e instanceof RouterError && e.kind === 'all_failed' && e.attempts[0]!.outcome === 'timeout');
    assert.ok(sawAbort);
  } finally {
    g.AbortController = saved;
  }
});

test('fetchTransport 는 POST + redirect:"manual" 로 한 번만 부른다', async () => {
  const seen: { url: string; init: FetchInit }[] = [];
  const transport = fetchTransport(async (url: string, init: FetchInit) => {
    seen.push({ url, init });
    return { status: 302, text: async () => 'moved' };
  });
  const ctrl = new AbortController();
  const res = await transport({ url: 'http://x/chat/completions', headers: { a: 'b' }, body: '{}', signal: ctrl.signal });
  assert.deepEqual(res, { status: 302, text: 'moved' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal(seen[0]!.init.redirect, 'manual');
  assert.equal(seen[0]!.init.signal, ctrl.signal);
});

test('transport 가 동기 예외를 던지면 network_error', async () => {
  const router = new Router(baseConfig({ numRetries: 0 }), { p1: 'k' }, {
    transport: () => {
      throw new TypeError('boom');
    },
    rng: () => 0,
  });
  await assert.rejects(router.route('chat', hi), (e: unknown) => {
    return e instanceof RouterError && e.kind === 'all_failed' && e.attempts[0]!.outcome === 'network_error' && e.attempts[0]!.message === 'boom';
  });
  assert.equal(router.deploymentStates()['a']!.recentFailures, 1);
});

test('요청 헤더: Content-Type: application/json, Authorization: Bearer <키>, extraHeaders (SPEC 3.6)', async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const config = {
    ...baseConfig(),
    providers: [{ id: 'p1', baseUrl: 'http://mock.invalid/p1/', extraHeaders: { 'X-Title': 't' } }],
  };
  const router = new Router(config, { p1: 'sk-1' }, {
    transport: async ({ url, headers, body }) => {
      seen.push({ url, headers, body });
      return { status: 200, text: okBody('m-a') };
    },
    rng: () => 0,
  });
  await router.route('chat', hi);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'http://mock.invalid/p1/chat/completions');
  assert.deepEqual(seen[0]!.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-1',
    'X-Title': 't',
  });
  assert.equal(JSON.parse(seen[0]!.body).model, 'm-a');
});
