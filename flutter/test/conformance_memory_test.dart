// SPEC 8.1: test-cases.json 의 모든 케이스를 메모리 transport 로, 모든 configCases 와 models.json 을 parseConfig 로.
import 'package:free_llm_router/testing.dart';
import 'package:test/test.dart';

import 'support/spec_files.dart';
import 'support/table.dart';

void main() {
  final suite = ConformanceSuite.parse(readSpecFile('test-cases.json'));
  final table = ResultTable([for (final c in suite.cases) c['name'] as String]);
  tearDownAll(table.printTable);

  test('suite has 41 cases and 42 configCases', () {
    expect(suite.cases, hasLength(41));
    expect(suite.configCases, hasLength(42));
  });

  test('models.json parses', () {
    expect(checkModelsJson(readSpecFile('models.json')), isEmpty);
  });

  group('memory', () {
    for (final c in suite.cases) {
      final name = c['name'] as String;
      final skip = skipReason(c, 'memory', includeSlow: false);
      if (skip != null) {
        table.results.add(CaseResult.skipped(name, 'memory', skip));
        test(name, () {}, skip: skip);
        continue;
      }
      test(name, () async {
        final sw = Stopwatch()..start();
        final failures = await runConformanceCase(
            suite, c, MemoryHarness((c['responses'] as Map).cast<String, Object?>()));
        table.results.add(CaseResult.ran(name, 'memory', failures, sw.elapsedMilliseconds));
        expect(failures, isEmpty, reason: failures.join('\n'));
      });
    }
  });

  group('configCases', () {
    for (final c in suite.configCases) {
      final name = c['name'] as String;
      test(name, () {
        final failures = runConfigCase(c);
        table.configResults[name] = failures;
        expect(failures, isEmpty, reason: failures.join('\n'));
      });
    }
  });
}
