#!/usr/bin/env node
// 적합성 러너: test-cases.json 의 모든 케이스를
//   (1) memory — 메모리 가짜 transport
//   (2) http   — 모의 서버(자식 프로세스) + 실제 fetch
// 로 돌리고 표로 출력한다. configCases(parseConfig 수용/거부)도 검사한다. 하나라도 실패하면 exit 1.
//
//   node run-conformance.mjs [--mode memory|http|both] [--case <name>] [--slow] [--verbose]
//
// tags 에 "slow" 가 있는 케이스는 http 모드에서만 의미가 있다(플랫폼 HTTP 클라이언트 자체 타임아웃 검사).
// memory 모드에서는 항상 건너뛰고, http 모드에서는 --slow 또는 --case 로 지정했을 때만 돈다. 건너뛰면 표에 SKIP.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Router, RouterError, ConfigError, fetchTransport, normalizeConfig, parseConfig } from './router.mjs';
import { ScriptBook, validateResponses } from '../mock-server/server.mjs';
import { validate } from './schema-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '..');
const MEMORY_BASE = 'http://mock.invalid';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODE = opt('--mode', 'both');
const ONLY = opt('--case', null);
const SLOW = args.includes('--slow');
const VERBOSE = args.includes('--verbose');
if (!['memory', 'http', 'both'].includes(MODE)) {
  console.error(`unknown --mode ${MODE} (memory|http|both)`);
  process.exit(2);
}

const suite = JSON.parse(readFileSync(join(SPEC, 'test-cases.json'), 'utf8'));
const schema = JSON.parse(readFileSync(join(SPEC, 'models.schema.json'), 'utf8'));
const cases = suite.cases.filter((c) => !ONLY || c.name === ONLY);
const configCases = (suite.configCases ?? []).filter((c) => !ONLY || c.name === ONLY);
if (cases.length + configCases.length === 0) {
  console.error(`no case matches --case ${ONLY}`);
  process.exit(1);
}
const isSlow = (c) => (c.tags ?? []).includes('slow');
// 이 모드에서 케이스를 건너뛰는 이유. 돌리면 null.
function skipReason(c, mode) {
  if (!isSlow(c)) return null;
  if (mode === 'memory') return 'slow: http only';
  return SLOW || ONLY ? null : 'slow: --slow';
}

// ── 도우미 ───────────────────────────────────────────

function substitute(v, base) {
  if (typeof v === 'string') return v.split(suite.mockBasePlaceholder).join(base);
  if (Array.isArray(v)) return v.map((x) => substitute(x, base));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, base)]));
  return v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const show = (v) => JSON.stringify(v);

function lowerKeys(h) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

// ── transport 두 가지 ────────────────────────────────

function memoryHarness(responses) {
  const problem = validateResponses(responses);
  if (problem) throw new Error(`responses: ${problem}`);
  const book = new ScriptBook(responses);
  const log = [];
  const transport = async ({ url, headers, body, signal }) => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    log.push({ path: new URL(url).pathname, headers: lowerKeys(headers), body: parsed });
    const r = book.next(String(parsed?.model));
    if (r.delayMs > 0) await sleep(r.delayMs, signal);
    if (r.action === 'close') throw new Error('connection closed');
    if (r.bodyDelayMs > 0) await sleep(r.bodyDelayMs, signal); // 본문 끝까지 받아야 응답이 완성된다
    return { status: r.status, text: r.text };
  };
  return { base: MEMORY_BASE, transport, fetchLog: async () => log };
}

async function startMockServer() {
  const child = spawn(process.execPath, [join(SPEC, 'mock-server', 'server.mjs'), '--port', '0', '--exit-on-stdin-close'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`mock server exited (${code})`)));
  });
  const { url } = JSON.parse(line);
  return {
    url,
    stop: () => {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

function httpHarness(serverUrl) {
  return {
    base: serverUrl,
    transport: fetchTransport(),
    async load(responses) {
      const r = await fetch(`${serverUrl}/__scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (r.status !== 200) throw new Error(`/__scenario → ${r.status}`);
    },
    fetchLog: async () => (await (await fetch(`${serverUrl}/__log`)).json()).requests,
  };
}

// ── 케이스 실행 ──────────────────────────────────────

function checkAttempts(fail, where, actual, expected) {
  const got = actual.map((a) => ({ deployment: a.deploymentId, group: a.group, outcome: a.outcome, status: a.status }));
  if (!deepEqual(got, expected)) fail(`${where} attempts\n      expected ${show(expected)}\n      actual   ${show(got)}`);
}

function checkRequests(fail, where, received, attempts, expect, config) {
  // 불변식: 시도마다 정확히 한 요청이 제공처에 도착하고, 경로와 body.model 이 그 배포의 것이어야 한다.
  if (received.length !== attempts.length) {
    fail(`${where} provider received ${received.length} requests, attempts ${attempts.length}`);
    return;
  }
  const deps = Object.values(config.groups).flatMap((g) => g.deployments);
  attempts.forEach((a, i) => {
    const d = deps.find((x) => x.id === a.deploymentId);
    const p = config.providers.find((x) => x.id === d.provider);
    const wantPath = new URL(p.baseUrl.replace(/\/+$/, '') + '/chat/completions').pathname;
    const r = received[i];
    if (r.path !== wantPath) fail(`${where} request[${i}] path ${r.path} != ${wantPath}`);
    if (r.body?.model !== d.model) fail(`${where} request[${i}] body.model ${show(r.body?.model)} != ${show(d.model)}`);
  });
  if (!expect.requests) return;
  if (expect.requests.length !== received.length) {
    fail(`${where} expected ${expect.requests.length} requests, got ${received.length}`);
    return;
  }
  expect.requests.forEach((er, i) => {
    const r = received[i];
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

// 취소 단계: cancelAfterMs 뒤(0 이면 호출 전에 이미) 취소. 기대: 언어 네이티브 취소 예외(RouterError 아님).
async function runCancelStep(fail, where, router, step, harness, config, getSeen, setSeen) {
  const ctrl = new AbortController();
  let timer = null;
  if (step.cancelAfterMs === 0) ctrl.abort();
  else timer = setTimeout(() => ctrl.abort(), step.cancelAfterMs);
  const t0 = Date.now();
  try {
    const r = await router.route(step.group, step.request, { signal: ctrl.signal });
    fail(`${where} expected cancellation, got success via ${r.deploymentId}`);
  } catch (x) {
    if (x instanceof RouterError) fail(`${where} expected cancellation, got RouterError ${x.kind}`);
    else if (x?.name !== 'AbortError') fail(`${where} expected AbortError, got ${x?.stack ?? x}`);
  } finally {
    clearTimeout(timer);
  }
  // 취소는 즉시 전파되어야 한다: 대기 중이던 응답(delayMs)을 끝까지 기다리면 실패.
  const elapsed = Date.now() - t0;
  if (elapsed > step.cancelAfterMs + 500) fail(`${where} cancellation took ${elapsed}ms`);
  const log = await harness.fetchLog();
  const received = log.slice(getSeen());
  setSeen(log.length);
  const want = step.expect.requests ?? [];
  if (received.length !== want.length) fail(`${where} provider received ${received.length} requests, expected ${want.length}`);
  want.forEach((er, i) => {
    if (er.path != null && received[i]?.path !== er.path) fail(`${where} request[${i}] path ${received[i]?.path} != ${er.path}`);
  });
}

async function runCase(c, harness) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const config = substitute(c.config, harness.base);

  const schemaErrors = validate(schema, config);
  if (schemaErrors.length) fail(`config schema: ${schemaErrors.join('; ')}`);

  let clock = suite.clockStartMs;
  let rngIndex = 0;
  const rng = () => {
    if (rngIndex >= c.rng.length) throw new Error(`rng exhausted after ${c.rng.length} values`);
    return c.rng[rngIndex++];
  };
  if (harness.load) await harness.load(c.responses);

  const router = new Router({ config, keys: c.keys, transport: harness.transport, rng, now: () => clock });
  let seen = 0;

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
      const states = router.deploymentStates();
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
      await runCancelStep(fail, where, router, step, harness, config, () => seen, (n) => (seen = n));
      continue;
    }
    let result = null;
    let error = null;
    try {
      result = await router.route(step.group, step.request);
    } catch (x) {
      if (!(x instanceof RouterError)) {
        fail(`${where} unexpected exception: ${x?.stack ?? x}`);
        return failures;
      }
      error = x;
    }
    const attempts = result ? result.attempts : error.attempts;

    if (e.ok) {
      if (!result) fail(`${where} expected success, got error ${error.kind} (${error.message})`);
      else {
        if (result.deploymentId !== e.deployment) fail(`${where} deployment ${result.deploymentId} != ${e.deployment}`);
        if (result.group !== e.group) fail(`${where} group ${result.group} != ${e.group}`);
        if (e.content !== undefined) {
          const content = result.response?.choices?.[0]?.message?.content;
          if (content !== e.content) fail(`${where} content ${show(content)} != ${show(e.content)}`);
        }
      }
    } else if (!error) {
      fail(`${where} expected error ${e.error.kind}, got success via ${result.deploymentId}`);
    } else {
      if (error.kind !== e.error.kind) fail(`${where} error.kind ${error.kind} != ${e.error.kind}`);
      if ((error.status ?? null) !== (e.error.status ?? null)) fail(`${where} error.status ${error.status} != ${e.error.status}`);
      if (e.error.bodyContains != null && !(typeof error.body === 'string' && error.body.includes(e.error.bodyContains))) {
        fail(`${where} error.body ${show(error.body)} does not contain ${show(e.error.bodyContains)}`);
      }
      if (e.error.kind !== 'non_retryable' && error.body != null) fail(`${where} error.body should be null for ${e.error.kind}`);
    }
    checkAttempts(fail, where, attempts, e.attempts);

    const log = await harness.fetchLog();
    const received = log.slice(seen);
    seen = log.length;
    checkRequests(fail, where, received, attempts, e, config);
  }

  if (rngIndex !== c.rng.length) fail(`rng used ${rngIndex} of ${c.rng.length} values`);
  return failures;
}

// ── models.json 검사 ────────────────────────────────

function checkModelsJson() {
  const models = JSON.parse(readFileSync(join(SPEC, 'models.json'), 'utf8'));
  const errs = validate(schema, models);
  try {
    normalizeConfig(models);
  } catch (e) {
    errs.push(e.message);
  }
  return errs;
}

// configCases: parseConfig 에 원문 JSON 을 넣어 수용(ok)/거부(config_error)를 본다.
function runConfigCase(c) {
  let got;
  let detail = '';
  try {
    parseConfig(c.json);
    got = 'ok';
  } catch (e) {
    if (!(e instanceof ConfigError)) return [`unexpected exception: ${e?.stack ?? e}`];
    got = 'config_error';
    detail = ` (${e.message})`;
  }
  return got === c.expect ? [] : [`expected ${c.expect}, got ${got}${detail}`];
}

// ── main ────────────────────────────────────────────

async function main() {
  const modes = MODE === 'both' ? ['memory', 'http'] : [MODE];
  const results = new Map(cases.map((c) => [c.name, {}]));
  let server = null;
  let anyFail = false;

  const modelErrs = checkModelsJson();
  console.log(`models.json: ${modelErrs.length ? 'FAIL\n  ' + modelErrs.join('\n  ') : 'ok (schema + normalizeConfig)'}`);
  if (modelErrs.length) anyFail = true;

  try {
    for (const mode of modes) {
      let harnessFor;
      if (mode === 'http') {
        server = await startMockServer();
        console.log(`mock server: ${server.url}`);
        const h = httpHarness(server.url);
        harnessFor = () => h;
      } else {
        harnessFor = (c) => memoryHarness(c.responses);
      }
      for (const c of cases) {
        const skip = skipReason(c, mode);
        if (skip) {
          results.get(c.name)[mode] = { skip };
          continue;
        }
        const t0 = Date.now();
        let failures;
        try {
          failures = await runCase(c, harnessFor(c));
        } catch (x) {
          failures = [`harness error: ${x?.stack ?? x}`];
        }
        results.get(c.name)[mode] = { failures, ms: Date.now() - t0 };
        if (failures.length) anyFail = true;
      }
    }
  } finally {
    server?.stop();
  }

  // 표
  const w = Math.max(4, ...cases.map((c) => c.name.length));
  const cell = (r) => (!r ? '-' : r.skip ? `SKIP ${r.skip}` : (r.failures.length ? 'FAIL' : 'PASS') + ` ${String(r.ms).padStart(5)}ms`);
  console.log('');
  console.log(`${'case'.padEnd(w)} | ${modes.map((m) => m.padEnd(16)).join(' | ')}`);
  console.log(`${'-'.repeat(w)}-|-${modes.map(() => '-'.repeat(16)).join('-|-')}`);
  for (const c of cases) {
    const r = results.get(c.name);
    console.log(`${c.name.padEnd(w)} | ${modes.map((m) => cell(r[m]).padEnd(16)).join(' | ')}`);
  }

  // parseConfig 케이스
  let configPassed = 0;
  if (configCases.length) {
    const wc = Math.max(...configCases.map((c) => c.name.length));
    console.log(`\n${'config case'.padEnd(wc)} | expect       | result`);
    for (const c of configCases) {
      const f = runConfigCase(c);
      if (f.length) anyFail = true;
      else configPassed++;
      console.log(`${c.name.padEnd(wc)} | ${c.expect.padEnd(12)} | ${f.length ? 'FAIL ' + f.join('; ') : 'PASS'}`);
    }
  }

  for (const c of cases) {
    for (const m of modes) {
      const r = results.get(c.name)[m];
      if (r?.failures?.length) {
        console.log(`\n✗ ${c.name} [${m}]`);
        for (const f of r.failures) console.log(`    - ${f}`);
      }
    }
  }

  const ran = cases.flatMap((c) => modes.map((m) => results.get(c.name)[m])).filter((r) => r && !r.skip);
  const skipped = cases.length * modes.length - ran.length;
  const passed = ran.filter((r) => r.failures.length === 0).length;
  console.log(
    `\n${passed}/${ran.length} passed (${cases.length} cases × ${modes.join(', ')}; ${skipped} skipped)` +
      `, config ${configPassed}/${configCases.length} passed`,
  );
  if (ran.length + configCases.length === 0) anyFail = true;
  if (VERBOSE) console.log(JSON.stringify(Object.fromEntries(results), null, 2));
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
