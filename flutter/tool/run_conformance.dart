// 참조 러너(spec/reference/run-conformance.mjs)와 같은 모양의 표를 찍는 CLI.
//   dart run tool/run_conformance.dart [--mode memory|http|both] [--case <name>] [--slow]
// 실패가 있으면 exit 1, 알 수 없는 --mode 는 exit 2, 맞는 케이스가 없으면 exit 1.
import 'dart:io';

import 'package:free_llm_router/testing.dart';

import '../test/support/mock_server.dart';
import '../test/support/spec_files.dart';

Future<void> main(List<String> args) async {
  String? opt(String name) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }

  final mode = opt('--mode') ?? 'both';
  final only = opt('--case');
  if (!['memory', 'http', 'both'].contains(mode)) {
    stderr.writeln('unknown --mode $mode (memory|http|both)');
    exit(2);
  }
  final json = readSpecFile('test-cases.json');
  final suite = ConformanceSuite.parse(json);
  if (only != null &&
      !suite.cases.any((c) => c['name'] == only) &&
      !suite.configCases.any((c) => c['name'] == only)) {
    stderr.writeln('no case matches --case $only');
    exit(1);
  }
  final modelErrs = checkModelsJson(readSpecFile('models.json'));
  stdout.writeln('models.json: ${modelErrs.isEmpty ? 'ok (parseConfig)' : 'FAIL ${modelErrs.join('; ')}'}');

  final modes = mode == 'both' ? ['memory', 'http'] : [mode];
  MockServer? server;
  if (modes.contains('http')) {
    final why = MockServer.unavailableReason();
    if (why != null) {
      stderr.writeln('*** HTTP MODE SKIPPED: $why ***');
      modes.remove('http');
    } else {
      server = await MockServer.start();
      stdout.writeln('mock server: ${server.url}');
    }
  }
  try {
    final report = await runConformance(
      testCasesJson: json,
      modes: modes,
      mockUrl: server?.url,
      includeSlow: args.contains('--slow'),
      only: only,
    );
    stdout.writeln('\n${report.format()}');
    exitCode = report.allPassed && modelErrs.isEmpty ? 0 : 1;
  } finally {
    await server?.stop();
  }
  exit(exitCode);
}
