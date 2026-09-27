import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'spec_files.dart';

/// 모의 서버 (SPEC 8.2): FLR_MOCK_URL 이 있으면 그걸 쓰고, 없으면 node 로 직접 띄운다.
class MockServer {
  MockServer._(this.url, this._process);

  final String url;
  final Process? _process;

  /// 쓸 수 없으면 이유, 쓸 수 있으면 null (선언 시점에 동기로 판단해 SKIP 을 눈에 띄게 표시하기 위함).
  static String? unavailableReason() {
    final env = Platform.environment['FLR_MOCK_URL'];
    if (env != null && env.isNotEmpty) return null;
    try {
      final r = Process.runSync('node', ['--version']);
      if (r.exitCode == 0) return null;
    } on ProcessException {
      // 아래로
    }
    return 'no FLR_MOCK_URL and node not found';
  }

  static Future<MockServer> start() async {
    final env = Platform.environment['FLR_MOCK_URL'];
    if (env != null && env.isNotEmpty) return MockServer._(env.replaceFirst(RegExp(r'/+$'), ''), null);
    final p = await Process.start(
      'node',
      ['${specDir()}/mock-server/server.mjs', '--port', '0', '--exit-on-stdin-close'],
    );
    p.stderr.transform(utf8.decoder).listen(stderr.write);
    final lines = p.stdout.transform(utf8.decoder).transform(const LineSplitter());
    final first = await lines.first.timeout(const Duration(seconds: 10));
    final url = (jsonDecode(first) as Map)['url'] as String;
    return MockServer._(url, p);
  }

  Future<void> stop() async {
    final p = _process;
    if (p == null) return;
    await p.stdin.close();
    p.kill(ProcessSignal.sigterm);
    await p.exitCode.timeout(const Duration(seconds: 5), onTimeout: () {
      p.kill(ProcessSignal.sigkill);
      return -1;
    });
  }
}
