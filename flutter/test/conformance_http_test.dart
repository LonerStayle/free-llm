// SPEC 8.2: 같은 케이스를 LlmRouter 기본 transport(package:http, 실제 HTTP)로 모의 서버에 보낸다.
// slow 케이스는 FLR_SLOW=1 일 때만 돈다(아니면 SKIP 표시).
import 'dart:io';

import 'package:free_llm_router/testing.dart';
import 'package:test/test.dart';

import 'support/mock_server.dart';
import 'support/spec_files.dart';
import 'support/table.dart';

void main() {
  final suite = ConformanceSuite.parse(readSpecFile('test-cases.json'));
  final includeSlow = Platform.environment['FLR_SLOW'] == '1';
  final unavailable = MockServer.unavailableReason();
  final table = ResultTable([for (final c in suite.cases) c['name'] as String]);
  if (unavailable != null) {
    // 조용히 통과하지 않도록 눈에 띄게 (SPEC 8.2)
    stderr.writeln('\n*** HTTP CONFORMANCE SKIPPED: $unavailable ***\n');
  }

  MockServer? server;
  MockServerHarness? harness;
  setUpAll(() async {
    if (unavailable != null) return;
    server = await MockServer.start();
    harness = MockServerHarness(server!.url);
    // ignore: avoid_print
    print('mock server: ${server!.url}');
  });
  tearDownAll(() async {
    harness?.close();
    await server?.stop();
    table.printTable();
  });

  group('http', () {
    for (final c in suite.cases) {
      final name = c['name'] as String;
      final skip = unavailable != null
          ? 'mock server unavailable: $unavailable'
          : skipReason(c, 'http', includeSlow: includeSlow);
      if (skip != null) {
        table.results.add(CaseResult.skipped(name, 'http', skip));
        test(name, () {}, skip: skip, tags: isSlowCase(c) ? ['slow'] : null);
        continue;
      }
      test(name, () async {
        final sw = Stopwatch()..start();
        final failures = await runConformanceCase(suite, c, harness!);
        table.results.add(CaseResult.ran(name, 'http', failures, sw.elapsedMilliseconds));
        expect(failures, isEmpty, reason: failures.join('\n'));
      }, tags: isSlowCase(c) ? ['slow'] : null, timeout: const Timeout(Duration(seconds: 60)));
    }
  });
}
