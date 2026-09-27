// 표 출력 러너 (SPEC 8.3 권장 형식). 참조 러너와 같은 인자:
//   node build/__tests__/run-conformance.js [--mode memory|http|both] [--case <name>] [--slow]
// 하나라도 실패하면 exit 1, 알 수 없는 --mode 는 exit 2, 맞는 케이스가 없으면 exit 1.
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
import type { Case, Harness, MockServer } from './support/conformance.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const MODE = opt('--mode') ?? 'both';
const ONLY = opt('--case') ?? null;
const SLOW = args.includes('--slow');
if (!['memory', 'http', 'both'].includes(MODE)) {
  console.error(`unknown --mode ${MODE} (memory|http|both)`);
  process.exit(2);
}

const suite = loadSuite();
const cases = suite.cases.filter((c) => !ONLY || c.name === ONLY);
const configCases = suite.configCases.filter((c) => !ONLY || c.name === ONLY);
if (cases.length + configCases.length === 0) {
  console.error(`no case matches --case ${ONLY}`);
  process.exit(1);
}

function skipReason(c: Case, mode: string): string | null {
  if (!isSlow(c)) return null;
  if (mode === 'memory') return 'slow: http only';
  return SLOW || ONLY ? null : 'slow: --slow';
}

type Cell = { skip: string } | { failures: string[]; ms: number };

async function main() {
  console.log(`spec: ${SPEC_DIR}`);
  const modes = MODE === 'both' ? ['memory', 'http'] : [MODE];
  const results = new Map<string, Record<string, Cell>>(cases.map((c) => [c.name, {}]));
  let anyFail = false;
  let server: MockServer | null = null;
  try {
    for (const mode of modes) {
      let harnessFor: (c: Case) => Harness;
      if (mode === 'http') {
        try {
          server = await startMockServer();
        } catch (e) {
          console.log(`\n!!! HTTP MODE SKIPPED: mock server unavailable: ${String(e)}\n`);
          for (const c of cases) results.get(c.name)![mode] = { skip: 'no mock server' };
          anyFail = true; // 필수 e2e 를 못 돌렸으면 통과로 치지 않는다
          continue;
        }
        console.log(`mock server: ${server.url}`);
        const h = httpHarness(server.url);
        harnessFor = () => h;
      } else {
        harnessFor = (c) => memoryHarness(c.responses);
      }
      for (const c of cases) {
        const skip = skipReason(c, mode);
        if (skip) {
          results.get(c.name)![mode] = { skip };
          continue;
        }
        const t0 = Date.now();
        let failures: string[];
        try {
          failures = await runCase(suite, c, harnessFor(c));
        } catch (x) {
          failures = [`harness error: ${x instanceof Error ? x.stack : String(x)}`];
        }
        results.get(c.name)![mode] = { failures, ms: Date.now() - t0 };
        if (failures.length) anyFail = true;
      }
    }
  } finally {
    server?.stop();
  }

  const w = Math.max(4, ...cases.map((c) => c.name.length));
  const cell = (r: Cell | undefined) =>
    !r ? '-' : 'skip' in r ? `SKIP ${r.skip}` : `${r.failures.length ? 'FAIL' : 'PASS'} ${String(r.ms).padStart(5)}ms`;
  console.log('');
  console.log(`${'case'.padEnd(w)} | ${modes.map((m) => m.padEnd(16)).join(' | ')}`);
  console.log(`${'-'.repeat(w)}-|-${modes.map(() => '-'.repeat(16)).join('-|-')}`);
  for (const c of cases) {
    const r = results.get(c.name)!;
    console.log(`${c.name.padEnd(w)} | ${modes.map((m) => cell(r[m]).padEnd(16)).join(' | ')}`);
  }

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
      const r = results.get(c.name)![m];
      if (r && 'failures' in r && r.failures.length) {
        console.log(`\nFAIL ${c.name} [${m}]`);
        for (const f of r.failures) console.log(`    - ${f}`);
      }
    }
  }

  const ran = cases.flatMap((c) => modes.map((m) => results.get(c.name)![m])).filter((r): r is { failures: string[]; ms: number } => !!r && 'failures' in r);
  const skipped = cases.length * modes.length - ran.length;
  const passed = ran.filter((r) => r.failures.length === 0).length;
  console.log(
    `\n${passed}/${ran.length} passed (${cases.length} cases x ${modes.join(', ')}; ${skipped} skipped)` +
      `, config ${configPassed}/${configCases.length} passed`,
  );
  if (ran.length + configCases.length === 0) anyFail = true;
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
