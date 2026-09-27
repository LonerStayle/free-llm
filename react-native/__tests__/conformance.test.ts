// SPEC 8.1(메모리) + 8.2(모의 서버 경유 실제 fetch) 적합성. 요청 순서대로 돈다(모의 서버는 공유 상태).
// slow 케이스는 FLR_SLOW=1 일 때만 http 모드에서 돈다. 아니면 SKIP 으로 표시.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  httpHarness,
  isSlow,
  loadSuite,
  memoryHarness,
  runCase,
  runConfigCase,
  startMockServer,
  SPEC_DIR,
} from './support/conformance.js';
import type { Harness, MockServer } from './support/conformance.js';

const suite = loadSuite();
const SLOW = process.env.FLR_SLOW === '1';
const ONLY = process.env.FLR_CASE;
const cases = suite.cases.filter((c) => !ONLY || c.name === ONLY);

describe(`conformance memory (${SPEC_DIR})`, { concurrency: 1 }, () => {
  for (const c of cases) {
    test(c.name, { skip: isSlow(c) ? 'slow: http only' : false }, async () => {
      const failures = await runCase(suite, c, memoryHarness(c.responses));
      assert.deepEqual(failures, []);
    });
  }
});

describe('conformance http (mock server + fetch)', { concurrency: 1 }, () => {
  let server: MockServer | null = null;
  let harness: Harness | null = null;
  let startError: unknown = null;
  before(async () => {
    try {
      server = await startMockServer();
      harness = httpHarness(server.url);
      console.log(`mock server: ${server.url}`);
    } catch (e) {
      startError = e;
      // 조용히 통과하지 않는다 (SPEC 8.2)
      console.log(`\n!!! HTTP CONFORMANCE SKIPPED: mock server unavailable: ${String(e)}\n`);
    }
  });
  after(() => server?.stop());

  for (const c of cases) {
    const skip = isSlow(c) && !SLOW && !ONLY ? 'slow: set FLR_SLOW=1 (npm run test:slow)' : false;
    test(c.name, { skip }, async (t) => {
      if (!harness) {
        t.skip(`mock server unavailable: ${String(startError)}`);
        return;
      }
      const failures = await runCase(suite, c, harness);
      assert.deepEqual(failures, []);
    });
  }
});

describe('configCases (parseConfig)', () => {
  for (const c of suite.configCases.filter((x) => !ONLY || x.name === ONLY)) {
    test(`${c.name} -> ${c.expect}`, () => {
      assert.deepEqual(runConfigCase(c), []);
    });
  }
});
