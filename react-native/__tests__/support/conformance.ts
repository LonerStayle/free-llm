// 적합성 하네스 (SPEC 8.1 메모리 transport, 8.2 모의 서버 경유 실제 fetch).
// spec/test-cases.json 을 복사하지 않고 spec/ 에서 읽는다 (FLR_SPEC_DIR, 없으면 저장소의 ../spec).
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, RouterError, ConfigError, fetchTransport, parseConfig } from 'free-llm-router';
import type { ChatRequest, Transport, TransportRequest } from 'free-llm-router';

// ── spec 위치·파일 ───────────────────────────────────

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).name === 'free-llm-router') return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('package root not found');
    dir = up;
  }
}

export const PACKAGE_ROOT = packageRoot();
export const SPEC_DIR = resolve(process.env.FLR_SPEC_DIR ?? join(PACKAGE_ROOT, '..', 'spec'));
export const MEMORY_BASE = 'http://mock.invalid';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObj = { [k: string]: Json };

export interface ScriptEntry {
  status?: number;
  body?: string | JsonObj | Json[];
  headers?: Record<string, string>;
  delayMs?: number;
  bodyDelayMs?: number;
  action?: 'close';
}
export type Responses = Record<string, ScriptEntry[]>;

interface ExpectedAttempt {
  deployment: string;
  group: string;
  outcome: string;
  status: number | null;
}
interface ExpectedRequest {
  path?: string;
  headers?: Record<string, string>;
  absentHeaders?: string[];
  body?: Json;
}
interface RequestStep {
  op: 'request';
  group: string;
  request: JsonObj;
  cancelAfterMs?: number;
  expect: {
    ok?: boolean;
    cancelled?: boolean;
    deployment?: string;
    group?: string;
    content?: string;
    error?: { kind: string; status?: number | null; bodyContains?: string };
    attempts?: ExpectedAttempt[];
    requests?: ExpectedRequest[];
  };
}
type Step =
  | RequestStep
  | { op: 'advance'; ms: number }
  | { op: 'reset' }
  | { op: 'expectState'; states: Record<string, Record<string, Json>> };

export interface Case {
  name: string;
  description?: string;
  tags?: string[];
  config: JsonObj;
  keys: Record<string, string>;
  rng: number[];
  responses: Responses;
  steps: Step[];
}
export interface ConfigCase {
  name: string;
  description?: string;
  json: string;
  expect: 'ok' | 'config_error';
}
export interface Suite {
  clockStartMs: number;
  mockBasePlaceholder: string;
  cases: Case[];
  configCases: ConfigCase[];
}

export function loadSuite(): Suite {
  return JSON.parse(readFileSync(join(SPEC_DIR, 'test-cases.json'), 'utf8')) as Suite;
}

export const isSlow = (c: Case) => (c.tags ?? []).includes('slow');

// ── 도우미 ───────────────────────────────────────────

function substitute(v: Json, placeholder: string, base: string): Json {
  if (typeof v === 'string') return v.split(placeholder).join(base);
  if (Array.isArray(v)) return v.map((x) => substitute(x, placeholder, base));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, placeholder, base)]));
  return v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  return ka.length === Object.keys(bo).length && ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

const show = (v: unknown) => JSON.stringify(v);

function sleep(ms: number, signal: TransportRequest['signal']): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error('aborted'));
    const onAbort = () => {
      clearTimeout(t);
      rej(new Error('aborted'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      res();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── 하네스 ───────────────────────────────────────────

export interface LoggedRequest {
  path: string;
  headers: Record<string, string>;
  body: Json;
}

export interface Harness {
  base: string;
  transport: Transport;
  load?(responses: Responses): Promise<void>;
  fetchLog(): Promise<LoggedRequest[]>;
}

// 모의 서버와 같은 응답 규칙(SPEC 8.1): 모델별 스크립트를 순서대로, 다 쓰면 기본 200.
function materialize(entry: ScriptEntry, model: string, seq: number) {
  const status = entry.status ?? 200;
  let text: string;
  if (entry.body === undefined) {
    text = JSON.stringify(
      status >= 200 && status <= 299
        ? {
            id: `mock-${seq}`,
            object: 'chat.completion',
            created: 0,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: `ok:${model}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }
        : { error: { message: `mock status ${status}`, code: status } },
    );
  } else text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
  return { status, text, delayMs: entry.delayMs ?? 0, bodyDelayMs: entry.bodyDelayMs ?? 0, action: entry.action ?? null };
}

export function memoryHarness(responses: Responses): Harness {
  const used = new Map<string, number>();
  let seq = 0;
  const log: LoggedRequest[] = [];
  const transport: Transport = async ({ url, headers, body, signal }) => {
    let parsed: Json;
    try {
      parsed = JSON.parse(body) as Json;
    } catch {
      parsed = body;
    }
    log.push({
      path: new URL(url).pathname,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: parsed,
    });
    const model = String(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed['model'] : undefined);
    const i = used.get(model) ?? 0;
    used.set(model, i + 1);
    seq++;
    const list = Object.prototype.hasOwnProperty.call(responses, model) ? responses[model]! : [];
    const r = materialize(i < list.length ? list[i]! : {}, model, seq);
    if (r.delayMs > 0) await sleep(r.delayMs, signal);
    if (r.action === 'close') throw new Error('connection closed');
    if (r.bodyDelayMs > 0) await sleep(r.bodyDelayMs, signal); // 본문 끝까지 받아야 응답 완성
    return { status: r.status, text: r.text };
  };
  return { base: MEMORY_BASE, transport, fetchLog: async () => log };
}

export interface MockServer {
  url: string;
  stop(): void;
}

/** FLR_MOCK_URL 이 있으면 그 서버, 없으면 spec 의 모의 서버를 자식 프로세스로 띄운다. */
export async function startMockServer(): Promise<MockServer> {
  if (process.env.FLR_MOCK_URL) return { url: process.env.FLR_MOCK_URL.replace(/\/+$/, ''), stop() {} };
  const script = join(SPEC_DIR, 'mock-server', 'server.mjs');
  if (!existsSync(script)) throw new Error(`mock server not found: ${script}`);
  const child = spawn(process.execPath, [script, '--port', '0', '--exit-on-stdin-close'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((res, rej) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once('line', (l) => {
      rl.close();
      res(l);
    });
    child.once('error', rej);
    child.once('exit', (code) => rej(new Error(`mock server exited (${code})`)));
  });
  const { url } = JSON.parse(line) as { url: string };
  return {
    url,
    stop() {
      child.stdin!.end();
      child.kill('SIGTERM');
    },
  };
}

export function httpHarness(serverUrl: string): Harness {
  return {
    base: serverUrl,
    transport: fetchTransport(), // 라이브러리 기본 transport 그대로 (redirect: 'manual')
    async load(responses) {
      const r = await fetch(`${serverUrl}/__scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (r.status !== 200) throw new Error(`/__scenario -> ${r.status} ${await r.text()}`);
    },
    async fetchLog() {
      const j = (await (await fetch(`${serverUrl}/__log`)).json()) as { requests: LoggedRequest[] };
      return j.requests;
    },
  };
}

// ── 케이스 실행 ──────────────────────────────────────

interface ConfigShape {
  providers: { id: string; baseUrl: string }[];
  groups: Record<string, { deployments: { id: string; provider: string; model: string }[] }>;
}

function checkRequests(
  fail: (m: string) => void,
  where: string,
  received: LoggedRequest[],
  attempts: readonly { deploymentId: string }[],
  expect: RequestStep['expect'],
  config: ConfigShape,
) {
  // 불변식: 시도마다 정확히 한 요청, 경로와 body.model 이 그 배포의 것
  if (received.length !== attempts.length) {
    fail(`${where} provider received ${received.length} requests, attempts ${attempts.length}`);
    return;
  }
  const deps = Object.values(config.groups).flatMap((g) => g.deployments);
  attempts.forEach((a, i) => {
    const d = deps.find((x) => x.id === a.deploymentId)!;
    const p = config.providers.find((x) => x.id === d.provider)!;
    const wantPath = new URL(p.baseUrl.replace(/\/+$/, '') + '/chat/completions').pathname;
    const r = received[i]!;
    const model = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body['model'] : undefined;
    if (r.path !== wantPath) fail(`${where} request[${i}] path ${r.path} != ${wantPath}`);
    if (model !== d.model) fail(`${where} request[${i}] body.model ${show(model)} != ${show(d.model)}`);
  });
  if (!expect.requests) return;
  if (expect.requests.length !== received.length) {
    fail(`${where} expected ${expect.requests.length} requests, got ${received.length}`);
    return;
  }
  expect.requests.forEach((er, i) => {
    const r = received[i]!;
    if (er.path != null && r.path !== er.path) fail(`${where} request[${i}] path ${r.path} != ${er.path}`);
    for (const [k, v] of Object.entries(er.headers ?? {})) {
      const got = r.headers[k.toLowerCase()];
      if (got !== v) fail(`${where} request[${i}] header ${k}: ${show(got)} != ${show(v)}`);
    }
    for (const k of er.absentHeaders ?? []) {
      if (k.toLowerCase() in r.headers) fail(`${where} request[${i}] header ${k} should be absent`);
    }
    if (er.body !== undefined && !deepEqual(r.body, er.body)) {
      fail(`${where} request[${i}] body\n      expected ${show(er.body)}\n      actual   ${show(r.body)}`);
    }
  });
}

/** 케이스 하나를 돌려 실패 메시지 목록을 돌려준다 (비면 통과). */
export async function runCase(suite: Suite, c: Case, harness: Harness): Promise<string[]> {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const config = substitute(c.config, suite.mockBasePlaceholder, harness.base) as unknown as ConfigShape;

  let clock = suite.clockStartMs;
  let rngIndex = 0;
  const rng = () => {
    if (rngIndex >= c.rng.length) throw new Error(`rng exhausted after ${c.rng.length} values`);
    return c.rng[rngIndex++]!;
  };
  if (harness.load) await harness.load(c.responses);

  // 공개 경로 그대로: JSON 문자열 → parseConfig → Router
  const router = new Router(parseConfig(JSON.stringify(config)), c.keys, { transport: harness.transport, rng, now: () => clock });
  let seen = 0;
  const newRequests = async () => {
    const log = await harness.fetchLog();
    const received = log.slice(seen);
    seen = log.length;
    return received;
  };

  for (const [i, step] of c.steps.entries()) {
    const where = `step ${i} (${step.op})`;
    if (step.op === 'advance') {
      clock += step.ms;
      continue;
    }
    if (step.op === 'reset') {
      router.resetState();
      continue;
    }
    if (step.op === 'expectState') {
      const states = router.deploymentStates() as unknown as Record<string, Record<string, unknown>>;
      for (const [id, want] of Object.entries(step.states)) {
        const got = states[id];
        if (!got) {
          fail(`${where} unknown deployment ${id}`);
          continue;
        }
        for (const [k, v] of Object.entries(want)) {
          if (got[k] !== v) fail(`${where} ${id}.${k} expected ${show(v)}, actual ${show(got[k])}`);
        }
      }
      continue;
    }
    if (step.op !== 'request') {
      fail(`${where} unknown op`);
      continue;
    }

    const e = step.expect;
    if (step.cancelAfterMs != null) {
      // 취소 단계: 0 이면 이미 취소된 signal, 아니면 그 ms 뒤 abort
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (step.cancelAfterMs === 0) ctrl.abort();
      else timer = setTimeout(() => ctrl.abort(), step.cancelAfterMs);
      const t0 = Date.now();
      try {
        const r = await router.route(step.group, step.request as unknown as ChatRequest, { signal: ctrl.signal });
        fail(`${where} expected cancellation, got success via ${r.deploymentId}`);
      } catch (x) {
        if (x instanceof RouterError) fail(`${where} expected cancellation, got RouterError ${x.kind}`);
        else if ((x as { name?: unknown } | null)?.name !== 'AbortError') fail(`${where} expected AbortError, got ${String(x)}`);
        else if (x !== ctrl.signal.reason) fail(`${where} thrown value is not signal.reason`);
      } finally {
        clearTimeout(timer);
      }
      const elapsed = Date.now() - t0;
      if (elapsed > step.cancelAfterMs + 500) fail(`${where} cancellation took ${elapsed}ms`);
      const received = await newRequests();
      const want = e.requests ?? [];
      if (received.length !== want.length) fail(`${where} provider received ${received.length} requests, expected ${want.length}`);
      want.forEach((er, j) => {
        if (er.path != null && received[j]?.path !== er.path) fail(`${where} request[${j}] path ${received[j]?.path} != ${er.path}`);
      });
      continue;
    }

    let result: Awaited<ReturnType<Router['route']>> | null = null;
    let error: RouterError | null = null;
    try {
      result = await router.route(step.group, step.request as unknown as ChatRequest);
    } catch (x) {
      if (!(x instanceof RouterError)) {
        fail(`${where} unexpected exception: ${x instanceof Error ? x.stack : String(x)}`);
        return failures;
      }
      error = x;
    }
    const attempts = result ? result.attempts : error!.attempts;

    if (e.ok) {
      if (!result) fail(`${where} expected success, got error ${error!.kind} (${error!.message})`);
      else {
        if (result.deploymentId !== e.deployment) fail(`${where} deployment ${result.deploymentId} != ${e.deployment}`);
        if (result.group !== e.group) fail(`${where} group ${result.group} != ${e.group}`);
        if (e.content !== undefined) {
          const choices = result.response['choices'] as { message?: { content?: unknown } }[] | undefined;
          const content = choices?.[0]?.message?.content;
          if (content !== e.content) fail(`${where} content ${show(content)} != ${show(e.content)}`);
        }
      }
    } else if (!error) {
      fail(`${where} expected error ${e.error?.kind}, got success via ${result!.deploymentId}`);
    } else {
      const want = e.error!;
      if (error.kind !== want.kind) fail(`${where} error.kind ${error.kind} != ${want.kind}`);
      if (error.status !== (want.status ?? null)) fail(`${where} error.status ${error.status} != ${want.status}`);
      if (want.bodyContains != null && !(typeof error.body === 'string' && error.body.includes(want.bodyContains))) {
        fail(`${where} error.body ${show(error.body)} does not contain ${show(want.bodyContains)}`);
      }
      if (want.kind !== 'non_retryable' && error.body !== null) fail(`${where} error.body should be null for ${want.kind}`);
    }
    const got = attempts.map((a) => ({ deployment: a.deploymentId, group: a.group, outcome: a.outcome, status: a.status }));
    if (!deepEqual(got, e.attempts)) fail(`${where} attempts\n      expected ${show(e.attempts)}\n      actual   ${show(got)}`);
    for (const a of attempts) {
      if (!(Number.isFinite(a.durationMs) && a.durationMs >= 0)) fail(`${where} bad durationMs ${a.durationMs}`);
    }

    checkRequests(fail, where, await newRequests(), attempts, e, config);
  }

  if (rngIndex !== c.rng.length) fail(`rng used ${rngIndex} of ${c.rng.length} values`);
  return failures;
}

/** configCases: parseConfig 수용(ok)/거부(config_error). */
export function runConfigCase(c: ConfigCase): string[] {
  let got: 'ok' | 'config_error';
  let detail = '';
  try {
    parseConfig(c.json);
    got = 'ok';
  } catch (e) {
    if (!(e instanceof ConfigError)) return [`unexpected exception: ${e instanceof Error ? e.stack : String(e)}`];
    got = 'config_error';
    detail = ` (${e.message})`;
  }
  return got === c.expect ? [] : [`expected ${c.expect}, got ${got}${detail}`];
}
