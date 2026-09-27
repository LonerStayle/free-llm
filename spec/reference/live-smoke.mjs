#!/usr/bin/env node
// 실제 제공처 스모크 테스트 (규약: ../live-smoke.md).
// OPENROUTER_API_KEY 환경변수가 없으면 SKIP 하고 exit 0. 키 파일은 읽지 않는다.
//
//   OPENROUTER_API_KEY=... node live-smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Router, RouterError } from './router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.log('LIVE SKIP OPENROUTER_API_KEY not set');
  process.exit(0);
}

const config = JSON.parse(readFileSync(join(HERE, '..', 'models.json'), 'utf8'));
config.settings = { ...config.settings, timeoutSeconds: 20 }; // 스모크 전용 (live-smoke.md)
const router = new Router({ config, keys: { openrouter: key } });

// 두 호출 합쳐 5분 제한. 넘기면 진행 중인 route 를 취소하고 실패.
const TOTAL_LIMIT_MS = 5 * 60 * 1000;
const total = new AbortController();
const limitTimer = setTimeout(() => total.abort(), TOTAL_LIMIT_MS);
const request = {
  messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  max_tokens: 256,
};

const fmt = (attempts) => attempts.map((a) => `${a.deploymentId}:${a.outcome}${a.status ? ':' + a.status : ''}:${a.durationMs}ms`).join(',');
let failed = false;
for (const group of ['fast', 'chat']) {
  const t0 = Date.now();
  try {
    const r = await router.route(group, request, { signal: total.signal });
    const content = String(r.response.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`LIVE ${group} ok deployment=${r.deploymentId} served_group=${r.group} ms=${Date.now() - t0} attempts=[${fmt(r.attempts)}] content=${JSON.stringify(content)}`);
  } catch (e) {
    failed = true;
    if (total.signal.aborted) {
      console.log(`LIVE TIMEOUT total>${TOTAL_LIMIT_MS / 1000}s (group ${group})`);
      break;
    } else if (e instanceof RouterError) {
      console.log(`LIVE ${group} FAIL kind=${e.kind} status=${e.status} ms=${Date.now() - t0} attempts=[${fmt(e.attempts)}]`);
    } else {
      console.log(`LIVE ${group} FAIL ${e?.message ?? e}`);
    }
  }
}
clearTimeout(limitTimer);
process.exit(failed ? 1 : 0);
