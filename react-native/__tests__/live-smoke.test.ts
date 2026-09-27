// 실제 제공처 스모크 (spec/live-smoke.md). OPENROUTER_API_KEY 환경변수가 있을 때만 돈다.
// 키는 환경변수에서만 읽고, 키·Authorization 은 출력하지 않는다. 일반 `npm test` 에는 들어 있지 않다.
//   OPENROUTER_API_KEY=... npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, RouterError, parseConfig } from 'free-llm-router';
import type { Attempt } from 'free-llm-router';
import { SPEC_DIR } from './support/conformance.js';

const key = process.env.OPENROUTER_API_KEY ?? '';
if (!key) console.log('LIVE SKIP OPENROUTER_API_KEY not set');

const TOTAL_LIMIT_MS = 5 * 60 * 1000;
const fmt = (attempts: readonly Attempt[]) =>
  attempts.map((a) => `${a.deploymentId}:${a.outcome}${a.status ? ':' + a.status : ''}:${a.durationMs}ms`).join(',');

test('live smoke (OpenRouter)', { skip: key ? false : 'LIVE SKIP OPENROUTER_API_KEY not set', timeout: TOTAL_LIMIT_MS + 30_000 }, async () => {
  const raw = JSON.parse(readFileSync(join(SPEC_DIR, 'models.json'), 'utf8')) as { settings?: Record<string, unknown> };
  raw.settings = { ...raw.settings, timeoutSeconds: 20 }; // 스모크 전용
  const router = new Router(parseConfig(JSON.stringify(raw)), { openrouter: key }); // 실제 fetch·시계·난수

  const total = new AbortController();
  const limit = setTimeout(() => total.abort(), TOTAL_LIMIT_MS);
  const request = { messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 256 };
  const failures: string[] = [];
  try {
    for (const group of ['fast', 'chat']) {
      const t0 = Date.now();
      try {
        const r = await router.route(group, request, { signal: total.signal });
        const choices = r.response['choices'] as { message?: { content?: unknown } }[];
        const content = String(choices[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
        console.log(
          `LIVE ${group} ok deployment=${r.deploymentId} served_group=${r.group} ms=${Date.now() - t0} attempts=[${fmt(r.attempts)}] content=${JSON.stringify(content)}`,
        );
      } catch (e) {
        if (total.signal.aborted) {
          console.log(`LIVE TIMEOUT total>${TOTAL_LIMIT_MS / 1000}s (group ${group})`);
          failures.push('timeout');
          break;
        }
        if (e instanceof RouterError) {
          console.log(`LIVE ${group} FAIL kind=${e.kind} status=${e.status} ms=${Date.now() - t0} attempts=[${fmt(e.attempts)}]`);
        } else {
          console.log(`LIVE ${group} FAIL ${e instanceof Error ? e.message : String(e)}`);
        }
        failures.push(group);
      }
    }
  } finally {
    clearTimeout(limit);
  }
  assert.deepEqual(failures, []);
});
