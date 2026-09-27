#!/usr/bin/env node
// 모의 제공처로 LiteLLM 게이트웨이의 실제 폴백 동작을 관찰하고, 명세(spec/reference/router.mjs) 동작과 나란히 비교한다.
// 실제 제공처·실제 키를 쓰지 않는다. 사용법은 ../README.md "모의 검증".
//
//   node gateway/test/mock-scenarios.mjs [--scenario <이름>] [--port 4100] [--out results.json]
//
// 시나리오마다: 모의 서버에 응답 스크립트를 올리고
//   (1) 명세 참조 라우터로 같은 요청을 보내 제공처 호출을 센다  → "spec"
//   (2) LiteLLM 컨테이너를 새로 띄워(쿨다운 상태 초기화) 같은 요청을 보낸다 → "litellm"
// 두 쪽의 핵심 지표(metric)가 같으면 MATCH, 다르면 DIFF. 다름은 관찰 결과이지 실패가 아니다(exit 0).
// 인프라 문제(도커·모의 서버·기동 실패)만 exit 1.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(process.env.FLR_SPEC_DIR ?? join(HERE, '../../spec'));
const { ScriptBook } = await import(pathToFileURL(join(SPEC_DIR, 'mock-server/server.mjs')).href);
const { Router, RouterError, fetchTransport } = await import(pathToFileURL(join(SPEC_DIR, 'reference/router.mjs')).href);

// docker-compose.yml 과 같은 이미지 (LiteLLM v1.101.0)
const IMAGE =
  process.env.FLR_GW_IMAGE ??
  'ghcr.io/berriai/litellm@sha256:d295634e09c648dcdb72c4cc2dd226f5fb87823a73e88cbbed6f205e4deb044b';
const CONTAINER = 'flr-gateway-mocktest';
const MASTER_KEY = 'sk-mock-gateway'; // 테스트 전용 더미 값

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const ONLY = opt('--scenario', null);
const GW_PORT = Number(opt('--port', '4100'));
const OUT = opt('--out', null);
const GW = `http://127.0.0.1:${GW_PORT}`;

// ── 시나리오 ─────────────────────────────────────────

const many = (n, e) => Array.from({ length: n }, () => ({ ...e }));
const CTX = {
  status: 400,
  body: {
    error: {
      message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
    },
  },
};
const CHAT = ['chat-a', 'chat-b', 'chat-c', 'chat-d'];
const FAST = ['fast-a', 'fast-b'];
const allOf = (models, entry, n = 30) => Object.fromEntries(models.map((m) => [m, many(n, entry)]));
const groupOf = (model) => model.split('-')[0];

// 요청 하나의 결과 요약: "ok:<응답한 그룹>" 또는 "fail"
const outcomes = (run) => histogram(run.requests.map((r) => (r.ok ? `ok:${r.servedGroup}` : 'fail')));
const callsTo = (run, model) => run.calls.filter((c) => c.model === model).length;
const callsByGroup = (run) => histogram(run.calls.map((c) => groupOf(c.model)));
// 같은 요청 안에서 같은 배포를 두 번 부른 요청 수
const repeatedInRequest = (run) =>
  run.requests.filter((r) => new Set(r.calls.map((c) => c.model)).size !== r.calls.length).length;
// model 이 실패한 직후 같은 요청 안에서 다음으로 부른 배포의 그룹들
const nextAfter = (run, model) => {
  const s = new Set();
  for (const r of run.requests) {
    r.calls.forEach((c, i) => {
      if (c.model === model && c.status !== 200) s.add(r.calls[i + 1] ? groupOf(r.calls[i + 1].model) : '(끝)');
    });
  }
  return [...s].sort().join(',');
};
const firstRequestShape = (run) => {
  const r = run.requests[0];
  return {
    result: r.ok ? `ok:${r.servedGroup}` : 'fail',
    calls: r.calls.length,
    chatCalls: r.calls.filter((c) => groupOf(c.model) === 'chat').length,
    fastCalls: r.calls.filter((c) => groupOf(c.model) === 'fast').length,
    distinctDeployments: new Set(r.calls.map((c) => c.model)).size,
  };
};

// 설정 변형. rpm 을 100배로 올리면 선택 비율은 같고 분당 한도(아래 rpm_is_hard_limit)만 사라진다.
const highRpm = (y) => y.replace(/rpm: (\d+)/g, (_, n) => `rpm: ${Number(n) * 100}`);
const allowedFails = (n) => (y) => y.replace(/allowed_fails: \d+/, `allowed_fails: ${n}`);
const both = (...fs) => (y) => fs.reduce((acc, f) => f(acc), y);
const cooldownMetric = (model) => (run) => ({
  outcomes: outcomes(run),
  [`${model}_calls`]: callsTo(run, model),
  [`nextAfter_${model}`]: nextAfter(run, model),
  requestsRepeatingADeployment: repeatedInRequest(run),
});

const SCENARIOS = [
  {
    name: 'success',
    title: '정상 성공 (chat 1회)',
    responses: {},
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: 'rpm_is_hard_limit',
    title: '모두 200, chat 30요청 — rpm 이 가중치만인지 분당 한도인지 (원래 rpm 그대로)',
    responses: {},
    requests: [{ group: 'chat', n: 30 }],
    metric: (run) => ({ outcomes: outcomes(run), callsByGroup: callsByGroup(run) }),
  },
  {
    name: '429_other_deployment',
    title: 'chat-a 만 항상 429 → 다른 배포 재시도, chat-a 는 몇 번 불리나 (30요청, rpm×100)',
    patch: highRpm,
    responses: { 'chat-a': many(200, { status: 429 }) },
    requests: [{ group: 'chat', n: 30 }],
    metric: cooldownMetric('chat-a'),
  },
  {
    name: '503_cooldown',
    title: 'chat-a 만 항상 503 → 3회 실패 뒤 쿨다운 되나 (30요청, rpm×100)',
    patch: highRpm,
    responses: { 'chat-a': many(200, { status: 503 }) },
    requests: [{ group: 'chat', n: 30 }],
    metric: cooldownMetric('chat-a'),
  },
  {
    name: '503_cooldown_allowed_fails_2',
    title: '위와 같되 allowed_fails: 2 (LiteLLM 기본값 3 이 아닌 값) — 명세의 "3회째 쿨다운" 과 같아지나',
    patch: both(highRpm, allowedFails(2)),
    responses: { 'chat-a': many(200, { status: 503 }) },
    requests: [{ group: 'chat', n: 30 }],
    metric: cooldownMetric('chat-a'),
  },
  {
    name: '429_allowed_fails_2',
    title: 'chat-a 만 항상 429, allowed_fails: 2 — 429 즉시 쿨다운이 사라지나',
    patch: both(highRpm, allowedFails(2)),
    responses: { 'chat-a': many(200, { status: 429 }) },
    requests: [{ group: 'chat', n: 30 }],
    metric: cooldownMetric('chat-a'),
  },
  {
    name: '429_cooldown_expires',
    title: 'chat-a 만 항상 429. 20요청 → 30초 대기 → 20요청 → 31초 대기 → 20요청. 쿨다운이 60초 뒤 풀리나 (rpm×100)',
    patch: highRpm,
    responses: { 'chat-a': many(200, { status: 429 }) },
    requests: [
      { group: 'chat', n: 20 },
      { waitMs: 30_000 },
      { group: 'chat', n: 20 },
      { waitMs: 31_000 },
      { group: 'chat', n: 20 },
    ],
    metric: (run) => ({
      outcomes: outcomes(run),
      'chat-a_calls_by_phase': [0, 1, 2].map((p) => run.requests.filter((r) => r.phase === p).flatMap((r) => r.calls).filter((c) => c.model === 'chat-a').length),
    }),
  },
  {
    name: '400_no_retry',
    title: 'chat 전부 400 → 재시도·폴백 없이 실패',
    responses: allOf(CHAT, { status: 400, body: { error: { message: 'invalid parameter: foo' } } }),
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: '401_auth',
    title: 'chat 전부 401 → 재시도·폴백 여부',
    responses: allOf(CHAT, { status: 401, body: { error: { message: 'invalid api key' } } }),
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: '403_forbidden',
    title: 'chat 전부 403 → 재시도·폴백 여부',
    responses: allOf(CHAT, { status: 403, body: { error: { message: 'forbidden' } } }),
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: 'group_fallback_chat_to_fast',
    title: 'chat 전부 503 → chat 안 재시도 뒤 fast 로 폴백',
    responses: allOf(CHAT, { status: 503 }),
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: 'fast_context_to_chat',
    title: 'fast 전부 컨텍스트 초과(400) → chat 으로',
    responses: allOf(FAST, CTX),
    requests: [{ group: 'fast', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: 'chat_context_no_fallback',
    title: 'chat 전부 컨텍스트 초과 → chat 은 contextWindowFallbacks 없음. fast 로 가나',
    responses: allOf(CHAT, CTX),
    requests: [{ group: 'chat', n: 1 }],
    metric: firstRequestShape,
  },
  {
    name: '404_model_gone',
    title: 'chat-a 만 항상 404 (목록에서 빠진 모델) (30요청, rpm×100)',
    patch: highRpm,
    responses: { 'chat-a': many(200, { status: 404, body: { error: { message: 'No endpoints found for chat-a' } } }) },
    requests: [{ group: 'chat', n: 30 }],
    metric: (run) => ({ outcomes: outcomes(run), 'chat-a_calls': callsTo(run, 'chat-a'), 'nextAfter_chat-a': nextAfter(run, 'chat-a') }),
  },
];

// 명세 쪽 설정. config.mock.yaml 과 같은 배포·가중치·설정.
function specConfig(mockUrl) {
  const dep = (id, rpm) => ({ id, provider: 'p1', model: id, rpm });
  return {
    version: 1,
    providers: [{ id: 'p1', baseUrl: `${mockUrl}/p1` }],
    groups: {
      chat: { deployments: [dep('chat-a', 6), dep('chat-b', 6), dep('chat-c', 4), dep('chat-d', 4)] },
      fast: { deployments: [dep('fast-a', 4), dep('fast-b', 3)] },
    },
    settings: {
      numRetries: 3,
      allowedFails: 3,
      cooldownSeconds: 60,
      timeoutSeconds: 60,
      fallbacks: { chat: ['fast'], fast: ['chat'] },
      contextWindowFallbacks: { fast: ['chat'] },
    },
  };
}

// ── 도우미 ───────────────────────────────────────────

function histogram(list) {
  const h = {};
  for (const x of list) h[x] = (h[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort());
}

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function startMock() {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [join(SPEC_DIR, 'mock-server/server.mjs'), '--port', '0', '--exit-on-stdin-close'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    p.on('error', fail);
    createInterface({ input: p.stdout }).once('line', (line) => ok({ proc: p, ...JSON.parse(line) }));
  });
}

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const removeGateway = () => {
  try {
    docker('rm', '-f', CONTAINER);
  } catch {}
};

async function portInUse(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (e) {
    return e?.cause?.code !== 'ECONNREFUSED';
  }
}

async function startGateway(mockPort, configPath) {
  removeGateway();
  docker(
    'run', '-d', '--rm', '--name', CONTAINER,
    '-p', `127.0.0.1:${GW_PORT}:4000`,
    '-e', `MOCK_API_BASE=http://host.docker.internal:${mockPort}/p1`,
    '-e', `LITELLM_MASTER_KEY=${MASTER_KEY}`,
    '-v', `${configPath}:/app/config.yaml:ro`,
    IMAGE, '--config', '/app/config.yaml',
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try {
      const r = await fetch(`${GW}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return Date.now() - t0;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let logs = '';
  try {
    logs = execFileSync('docker', ['logs', '--tail', '30', CONTAINER], { encoding: 'utf8' });
  } catch {}
  throw new Error(`LiteLLM 이 120초 안에 뜨지 않음\n${logs}`);
}

// 요청들을 순서대로 보내고, 모의 서버 로그로 제공처 호출을 요청별로 나눈다.
async function runRequests(mock, scenario, send) {
  await json(`${mock.url}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ responses: scenario.responses }),
  });
  const book = new ScriptBook(scenario.responses); // 서버와 같은 순서로 소비해 호출마다 준 상태를 복원한다
  const requests = [];
  const calls = [];
  let seen = 0;
  let phase = 0;
  for (const { group, n, waitMs } of scenario.requests) {
    if (waitMs) {
      await new Promise((r) => setTimeout(r, waitMs));
      phase++;
      continue;
    }
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const r = await send(group);
      const { requests: log } = await json(`${mock.url}/__log`);
      const mine = log.slice(seen).map((e) => {
        const model = e.body?.model;
        return { model, status: book.next(String(model)).status, retryHeader: e.headers['x-stainless-retry-count'] ?? null };
      });
      seen = log.length;
      calls.push(...mine);
      requests.push({ group, phase, ...r, ms: Date.now() - t0, calls: mine });
    }
  }
  return { requests, calls };
}

function specSender(mock) {
  const router = new Router({ config: specConfig(mock.url), keys: { p1: 'mock-key' }, transport: fetchTransport() });
  return async (group) => {
    try {
      const res = await router.route(group, { messages: [{ role: 'user', content: 'hi' }] });
      return { ok: true, servedGroup: res.group, detail: res.deploymentId };
    } catch (e) {
      if (!(e instanceof RouterError)) throw e;
      return { ok: false, detail: `${e.kind}${e.status ? ` ${e.status}` : ''}` };
    }
  };
}

async function litellmSend(group) {
  const res = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: group, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  const h = (k) => res.headers.get(k);
  if (res.ok) {
    const model = (h('x-litellm-model-name') ?? '').replace(/^openai\//, '');
    return {
      ok: true,
      servedGroup: groupOf(model),
      detail: `${model} retries=${h('x-litellm-attempted-retries')} fallbacks=${h('x-litellm-attempted-fallbacks')}`,
    };
  }
  let msg = text;
  try {
    msg = JSON.parse(text)?.error?.message ?? text;
  } catch {}
  return { ok: false, detail: `HTTP ${res.status} ${String(msg).replace(/\s+/g, ' ').slice(0, 160)}` };
}

function printRun(label, run) {
  console.log(`  [${label}]`);
  run.requests.forEach((r, i) => {
    const seq = r.calls.map((c) => `${c.model}:${c.status}${c.retryHeader && c.retryHeader !== '0' ? `(sdk-retry ${c.retryHeader})` : ''}`).join(' → ');
    console.log(`    #${i + 1} ${r.group} ${r.ok ? 'OK ' : 'ERR'} ${r.ms}ms  ${seq || '(호출 없음)'}  | ${r.detail}`);
  });
}

// ── 실행 ─────────────────────────────────────────────

const selected = SCENARIOS.filter((s) => !ONLY || s.name === ONLY);
if (selected.length === 0) {
  console.error(`시나리오 없음: ${ONLY}. 있는 것: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}
try {
  docker('version', '--format', '{{.Server.Version}}');
} catch {
  console.error('SKIP: docker 데몬에 연결할 수 없다. Docker Desktop 을 켜고 다시 실행한다.');
  process.exit(1);
}
if (await portInUse(GW_PORT)) {
  console.error(`포트 ${GW_PORT} 을 이미 쓰는 중이다 (실제 게이트웨이?). --port 로 다른 포트를 준다.`);
  process.exit(1);
}

const mock = await startMock();
const TMP = mkdtempSync(join(tmpdir(), 'flr-gw-'));
const cleanup = () => {
  removeGateway();
  mock.proc.kill();
  rmSync(TMP, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const results = [];
try {
  console.log(`mock ${mock.url}  gateway ${GW}  image ${IMAGE.slice(0, 60)}...`);
  for (const s of selected) {
    console.log(`\n■ ${s.name} — ${s.title}`);
    const spec = await runRequests(mock, s, specSender(mock));
    let configPath = join(HERE, 'config.mock.yaml');
    if (s.patch) {
      configPath = join(TMP, `${s.name}.yaml`);
      writeFileSync(configPath, s.patch(readFileSync(join(HERE, 'config.mock.yaml'), 'utf8')));
    }
    const bootMs = await startGateway(mock.port, configPath);
    let lite;
    try {
      lite = await runRequests(mock, s, litellmSend);
    } finally {
      removeGateway();
    }
    printRun('spec', spec);
    printRun(`litellm (기동 ${Math.round(bootMs / 1000)}s)`, lite);
    const ms = s.metric(spec);
    const ml = s.metric(lite);
    const match = JSON.stringify(ms) === JSON.stringify(ml);
    console.log(`  spec    ${JSON.stringify(ms)}`);
    console.log(`  litellm ${JSON.stringify(ml)}`);
    console.log(`  → ${match ? 'MATCH' : 'DIFF'}`);
    results.push({ name: s.name, title: s.title, match, spec: ms, litellm: ml, specRun: spec, litellmRun: lite });
  }
} catch (e) {
  console.error(`\n인프라 오류: ${e?.stack ?? e}`);
  cleanup();
  process.exit(1);
}
cleanup();

console.log('\n요약');
for (const r of results) console.log(`  ${r.match ? 'MATCH' : 'DIFF '}  ${r.name}`);
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
