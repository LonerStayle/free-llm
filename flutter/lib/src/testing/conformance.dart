// 적합성 러너 코어 (SPEC 8.1, 8.2). 파일 경로가 아니라 JSON 문자열을 받는다.
// 호스트 `dart test` 와 기기 integration_test 가 같이 쓴다. package:test 에 의존하지 않는다.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../cancel.dart';
import '../config.dart';
import '../router.dart';
import '../transport.dart';
import '../types.dart';
import 'script_book.dart';

typedef Json = Map<String, Object?>;

/// 메모리 모드의 `{{MOCK_BASE}}` 치환값.
const memoryBase = 'http://mock.invalid';

/// `spec/test-cases.json` 내용.
class ConformanceSuite {
  ConformanceSuite._(this.raw);

  factory ConformanceSuite.parse(String testCasesJson) =>
      ConformanceSuite._((jsonDecode(testCasesJson) as Map).cast<String, Object?>());

  final Json raw;

  int get clockStartMs => (raw['clockStartMs'] as num).toInt();
  String get placeholder => raw['mockBasePlaceholder'] as String;
  List<Json> get cases => [for (final c in raw['cases'] as List) (c as Map).cast<String, Object?>()];
  List<Json> get configCases =>
      [for (final c in (raw['configCases'] as List?) ?? const []) (c as Map).cast<String, Object?>()];
}

bool isSlowCase(Json c) => ((c['tags'] as List?) ?? const []).contains('slow');

/// 이 모드에서 케이스를 건너뛰는 이유. 돌리면 null. (참조 러너와 같은 규칙)
String? skipReason(Json c, String mode, {required bool includeSlow}) {
  if (!isSlowCase(c)) return null;
  if (mode == 'memory') return 'slow: http only';
  return includeSlow ? null : 'slow: FLR_SLOW=1';
}

/// 케이스 하나를 돌릴 환경. [transport] 가 null 이면 LlmRouter 기본 transport(실제 HTTP)를 쓴다.
abstract interface class ConformanceHarness {
  String get base;
  Transport? get transport;
  Future<void> load(Json responses);
  Future<List<Json>> fetchLog();
}

/// 8.1 메모리 transport. 케이스마다 새로 만든다.
class MemoryHarness implements ConformanceHarness {
  MemoryHarness(Json responses) {
    final problem = validateResponses(responses);
    if (problem != null) throw StateError('responses: $problem');
    _book = ScriptBook(responses);
  }

  late final ScriptBook _book;
  final List<Json> _log = [];
  late final Transport _transport = _MemoryTransport(this);

  @override
  String get base => memoryBase;

  @override
  Transport get transport => _transport;

  @override
  Future<void> load(Json responses) async {}

  @override
  Future<List<Json>> fetchLog() async => List.of(_log);
}

class _MemoryTransport implements Transport {
  _MemoryTransport(this._h);
  final MemoryHarness _h;

  @override
  Future<TransportResponse> send(
      String url, Map<String, String> headers, String body, CancelToken cancel) async {
    Object? parsed;
    try {
      parsed = jsonDecode(body);
    } on FormatException {
      parsed = body;
    }
    _h._log.add({
      'path': Uri.parse(url).path,
      'headers': {for (final e in headers.entries) e.key.toLowerCase(): e.value},
      'body': parsed,
    });
    final model = parsed is Map ? parsed['model'] : null;
    final r = _h._book.next('$model');
    if (r.delayMs > 0) await _sleep(r.delayMs, cancel);
    if (r.close) throw StateError('connection closed');
    if (r.bodyDelayMs > 0) await _sleep(r.bodyDelayMs, cancel); // 본문 끝까지 받아야 완성
    return TransportResponse(r.status, r.text);
  }
}

Future<void> _sleep(num ms, CancelToken cancel) {
  if (cancel.isCancelled) return Future.error(StateError('aborted'));
  final c = Completer<void>();
  late final void Function() unlisten;
  final t = Timer(Duration(microseconds: (ms * 1000).round()), () {
    unlisten();
    if (!c.isCompleted) c.complete();
  });
  unlisten = addCancelListener(cancel, () {
    t.cancel();
    if (!c.isCompleted) c.completeError(StateError('aborted'));
  });
  return c.future;
}

/// 8.2 모의 서버 경유. 라우터는 기본 transport([HttpTransport])로 [url] 에 보낸다.
class MockServerHarness implements ConformanceHarness {
  /// [url]: 모의 서버가 출력한 url (예 `http://127.0.0.1:53817`, 에뮬레이터면 `http://10.0.2.2:53817`).
  /// [transport]: null 이면 LlmRouter 기본 transport.
  MockServerHarness(this.url, {http.Client? control, this.transport}) : _control = control ?? http.Client();

  final String url;
  final http.Client _control;

  @override
  final Transport? transport;

  @override
  String get base => url;

  @override
  Future<void> load(Json responses) async {
    final r = await _control.post(
      Uri.parse('$url/__scenario'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'responses': responses}),
    );
    if (r.statusCode != 200) throw StateError('/__scenario → ${r.statusCode} ${r.body}');
  }

  @override
  Future<List<Json>> fetchLog() async {
    final r = await _control.get(Uri.parse('$url/__log'));
    final m = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
    return [for (final e in m['requests'] as List) (e as Map).cast<String, Object?>()];
  }

  void close() => _control.close();
}

// ── 도우미 ───────────────────────────────────────────

Object? _substitute(Object? v, String placeholder, String base) {
  if (v is String) return v.split(placeholder).join(base);
  if (v is List) return [for (final x in v) _substitute(x, placeholder, base)];
  if (v is Map) return {for (final e in v.entries) e.key as String: _substitute(e.value, placeholder, base)};
  return v;
}

/// JSON 깊은 비교 (키 순서 무시, 숫자는 값 비교).
bool jsonDeepEqual(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!jsonDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !jsonDeepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return a == b;
}

String _show(Object? v) => jsonEncode(v);

void _checkAttempts(void Function(String) fail, String where, List<Attempt> actual, Object? expected) {
  final got = [
    for (final a in actual)
      {'deployment': a.deploymentId, 'group': a.group, 'outcome': a.outcome.value, 'status': a.status}
  ];
  if (!jsonDeepEqual(got, expected)) {
    fail('$where attempts\n      expected ${_show(expected)}\n      actual   ${_show(got)}');
  }
}

void _checkRequests(
  void Function(String) fail,
  String where,
  List<Json> received,
  List<Attempt> attempts,
  Json expect,
  Json config,
) {
  // 불변식: 시도마다 정확히 한 요청, 경로·body.model 이 그 배포의 것.
  if (received.length != attempts.length) {
    fail('$where provider received ${received.length} requests, attempts ${attempts.length}');
    return;
  }
  final deps = [
    for (final g in (config['groups'] as Map).values)
      for (final d in (g as Map)['deployments'] as List) d as Map
  ];
  final providers = [for (final p in config['providers'] as List) p as Map];
  for (var i = 0; i < attempts.length; i++) {
    final d = deps.firstWhere((x) => x['id'] == attempts[i].deploymentId);
    final p = providers.firstWhere((x) => x['id'] == d['provider']);
    final wantPath =
        Uri.parse('${(p['baseUrl'] as String).replaceFirst(RegExp(r'/+$'), '')}/chat/completions').path;
    final r = received[i];
    if (r['path'] != wantPath) fail('$where request[$i] path ${r['path']} != $wantPath');
    final body = r['body'];
    final model = body is Map ? body['model'] : null;
    if (model != d['model']) fail('$where request[$i] body.model ${_show(model)} != ${_show(d['model'])}');
  }
  final want = expect['requests'] as List?;
  if (want == null) return;
  if (want.length != received.length) {
    fail('$where expected ${want.length} requests, got ${received.length}');
    return;
  }
  for (var i = 0; i < want.length; i++) {
    final er = want[i] as Map;
    final r = received[i];
    if (er['path'] != null && r['path'] != er['path']) {
      fail('$where request[$i] path ${r['path']} != ${er['path']}');
    }
    final headers = (r['headers'] as Map?) ?? const {};
    for (final e in ((er['headers'] as Map?) ?? const {}).entries) {
      final got = headers[(e.key as String).toLowerCase()];
      if (got != e.value) fail('$where request[$i] header ${e.key}: ${_show(got)} != ${_show(e.value)}');
    }
    for (final k in (er['absentHeaders'] as List?) ?? const []) {
      if (headers.containsKey((k as String).toLowerCase())) {
        fail('$where request[$i] header $k should be absent');
      }
    }
    if (er.containsKey('body') && !jsonDeepEqual(r['body'], er['body'])) {
      fail(
          '$where request[$i] body\n      expected ${_show(er['body'])}\n      actual   ${_show(r['body'])}');
    }
  }
}

// ── 케이스 실행 ──────────────────────────────────────

/// 케이스 하나를 돌려 실패 메시지 목록을 돌려준다(비었으면 통과).
Future<List<String>> runConformanceCase(ConformanceSuite suite, Json c, ConformanceHarness harness) async {
  final failures = <String>[];
  void fail(String m) => failures.add(m);
  final config = (_substitute(c['config'], suite.placeholder, harness.base) as Map).cast<String, Object?>();

  var clock = suite.clockStartMs;
  final rngValues = [for (final v in c['rng'] as List) (v as num).toDouble()];
  var rngIndex = 0;
  double rng() {
    if (rngIndex >= rngValues.length) throw StateError('rng exhausted after ${rngValues.length} values');
    return rngValues[rngIndex++];
  }

  await harness.load((c['responses'] as Map).cast<String, Object?>());

  final LlmRouter router;
  try {
    router = LlmRouter(
      Config.fromJson(config),
      (c['keys'] as Map).cast<String, String>(),
      transport: harness.transport,
      rng: rng,
      now: () => clock,
    );
  } on ConfigError catch (e) {
    return ['config rejected: ${e.message}'];
  }
  var seen = 0;

  // 기본 transport(http 모드)는 라우터가 소유하므로 케이스가 끝나면 닫는다.
  try {
    final steps = c['steps'] as List;
    for (var i = 0; i < steps.length; i++) {
      final step = (steps[i] as Map).cast<String, Object?>();
      final op = step['op'];
      final where = 'step $i ($op)';
      switch (op) {
        case 'advance':
          clock += (step['ms'] as num).toInt();
          continue;
        case 'reset':
          router.resetState();
          continue;
        case 'expectState':
          final states = router.deploymentStates();
          for (final e in (step['states'] as Map).entries) {
            final got = states[e.key];
            if (got == null) {
              fail('$where unknown deployment ${e.key}');
              continue;
            }
            final gotMap = {
              'coolingDown': got.coolingDown,
              'cooldownUntilMs': got.cooldownUntilMs,
              'recentFailures': got.recentFailures,
            };
            for (final f in (e.value as Map).entries) {
              if (!jsonDeepEqual(gotMap[f.key], f.value)) {
                fail('$where ${e.key}.${f.key} expected ${_show(f.value)}, actual ${_show(gotMap[f.key])}');
              }
            }
          }
          continue;
        case 'request':
          break;
        default:
          fail('$where unknown op');
          continue;
      }

      final group = step['group'] as String;
      final request = (step['request'] as Map).cast<String, Object?>();
      final e = (step['expect'] as Map).cast<String, Object?>();

      if (step['cancelAfterMs'] != null) {
        final cancelAfterMs = (step['cancelAfterMs'] as num).toInt();
        final token = CancelToken();
        Timer? timer;
        if (cancelAfterMs == 0) {
          token.cancel();
        } else {
          timer = Timer(Duration(milliseconds: cancelAfterMs), token.cancel);
        }
        final sw = Stopwatch()..start();
        try {
          final r = await router.route(group, request, cancelToken: token);
          fail('$where expected cancellation, got success via ${r.deploymentId}');
        } on RouteCancelledException {
          // 기대한 것
        } on RouterError catch (x) {
          fail('$where expected cancellation, got RouterError ${x.kind.value}');
        } catch (x) {
          fail('$where expected RouteCancelledException, got $x');
        } finally {
          timer?.cancel();
        }
        final elapsed = sw.elapsedMilliseconds;
        if (elapsed > cancelAfterMs + 500) fail('$where cancellation took ${elapsed}ms');
        final log = await harness.fetchLog();
        final received = log.sublist(seen);
        seen = log.length;
        final want = (e['requests'] as List?) ?? const [];
        if (received.length != want.length) {
          fail('$where provider received ${received.length} requests, expected ${want.length}');
        }
        for (var j = 0; j < want.length; j++) {
          final path = (want[j] as Map)['path'];
          final got = j < received.length ? received[j]['path'] : null;
          if (path != null && got != path) fail('$where request[$j] path $got != $path');
        }
        continue;
      }

      RouteResult? result;
      RouterError? error;
      try {
        result = await router.route(group, request);
      } on RouterError catch (x) {
        error = x;
      } catch (x, st) {
        fail('$where unexpected exception: $x\n$st');
        return failures;
      }
      final attempts = result?.attempts ?? error!.attempts;

      if (e['ok'] == true) {
        if (result == null) {
          fail('$where expected success, got error ${error!.kind.value} (${error.message})');
        } else {
          if (result.deploymentId != e['deployment']) {
            fail('$where deployment ${result.deploymentId} != ${e['deployment']}');
          }
          if (result.group != e['group']) fail('$where group ${result.group} != ${e['group']}');
          if (e.containsKey('content')) {
            Object? content;
            final choices = result.response['choices'];
            if (choices is List && choices.isNotEmpty && choices[0] is Map) {
              final msg = (choices[0] as Map)['message'];
              if (msg is Map) content = msg['content'];
            }
            if (content != e['content']) fail('$where content ${_show(content)} != ${_show(e['content'])}');
          }
        }
      } else {
        final ee = (e['error'] as Map).cast<String, Object?>();
        if (error == null) {
          fail('$where expected error ${ee['kind']}, got success via ${result!.deploymentId}');
        } else {
          if (error.kind.value != ee['kind']) fail('$where error.kind ${error.kind.value} != ${ee['kind']}');
          if (error.status != ee['status']) fail('$where error.status ${error.status} != ${ee['status']}');
          final bc = ee['bodyContains'];
          if (bc != null && !(error.body != null && error.body!.contains(bc as String))) {
            fail('$where error.body ${_show(error.body)} does not contain ${_show(bc)}');
          }
          if (ee['kind'] != 'non_retryable' && error.body != null) {
            fail('$where error.body should be null for ${ee['kind']}');
          }
        }
      }
      _checkAttempts(fail, where, attempts, e['attempts']);

      final log = await harness.fetchLog();
      final received = log.sublist(seen);
      seen = log.length;
      _checkRequests(fail, where, received, attempts, e, config);
    }

    if (rngIndex != rngValues.length) fail('rng used $rngIndex of ${rngValues.length} values');
    return failures;
  } finally {
    router.close();
  }
}

/// configCase 하나: parseConfig 수용(ok)/거부(config_error). 실패 메시지 목록.
List<String> runConfigCase(Json c) {
  String got;
  var detail = '';
  try {
    parseConfig(c['json'] as String);
    got = 'ok';
  } on ConfigError catch (e) {
    got = 'config_error';
    detail = ' (${e.message})';
  } catch (e) {
    return ['unexpected exception: $e'];
  }
  return got == c['expect'] ? const [] : ['expected ${c['expect']}, got $got$detail'];
}

/// models.json 이 parseConfig 를 통과하는지 (스키마 검사는 참조 러너가 한다).
List<String> checkModelsJson(String modelsJson) {
  try {
    parseConfig(modelsJson);
    return const [];
  } on ConfigError catch (e) {
    return [e.message];
  }
}

// ── 한 번에 돌리기 (기기 integration_test 용) ─────────

class CaseResult {
  CaseResult.skipped(this.name, this.mode, String this.skip)
      : failures = const [],
        ms = 0;
  CaseResult.ran(this.name, this.mode, this.failures, this.ms) : skip = null;

  final String name;
  final String mode;
  final String? skip;
  final List<String> failures;
  final int ms;

  bool get passed => skip == null && failures.isEmpty;
}

class ConformanceReport {
  ConformanceReport(this.results, this.configResults);

  final List<CaseResult> results;

  /// configCase 이름 → 실패 메시지 (비었으면 통과).
  final Map<String, List<String>> configResults;

  bool get allPassed =>
      results.every((r) => r.skip != null || r.failures.isEmpty) &&
      configResults.values.every((f) => f.isEmpty);

  /// 참조 러너와 같은 모양의 표 + 실패 상세 + 요약 한 줄.
  String format() {
    final modes = <String>{for (final r in results) r.mode}.toList();
    final names = <String>{for (final r in results) r.name}.toList();
    final w = [4, ...names.map((n) => n.length)].reduce((a, b) => a > b ? a : b);
    String cell(CaseResult? r) => r == null
        ? '-'
        : r.skip != null
            ? 'SKIP ${r.skip}'
            : '${r.failures.isEmpty ? 'PASS' : 'FAIL'} ${r.ms.toString().padLeft(5)}ms';
    final b = StringBuffer()
      ..writeln('${'case'.padRight(w)} | ${modes.map((m) => m.padRight(16)).join(' | ')}')
      ..writeln('${'-' * w}-|-${modes.map((_) => '-' * 16).join('-|-')}');
    for (final n in names) {
      final row = modes.map((m) {
        final r = results.where((x) => x.name == n && x.mode == m);
        return cell(r.isEmpty ? null : r.first).padRight(16);
      });
      b.writeln('${n.padRight(w)} | ${row.join(' | ')}');
    }
    if (configResults.isNotEmpty) {
      final wc = configResults.keys.map((k) => k.length).reduce((a, b) => a > b ? a : b);
      b.writeln('\n${'config case'.padRight(wc)} | result');
      for (final e in configResults.entries) {
        b.writeln('${e.key.padRight(wc)} | ${e.value.isEmpty ? 'PASS' : 'FAIL ${e.value.join('; ')}'}');
      }
    }
    for (final r in results.where((r) => r.failures.isNotEmpty)) {
      b.writeln('\n✗ ${r.name} [${r.mode}]');
      for (final f in r.failures) {
        b.writeln('    - $f');
      }
    }
    final ran = results.where((r) => r.skip == null).toList();
    final passed = ran.where((r) => r.failures.isEmpty).length;
    final configPassed = configResults.values.where((f) => f.isEmpty).length;
    b.write('\n$passed/${ran.length} passed (${names.length} cases × ${modes.join(', ')}; '
        '${results.length - ran.length} skipped)'
        '${configResults.isEmpty ? '' : ', config $configPassed/${configResults.length} passed'}');
    return b.toString();
  }
}

/// 모든 케이스를 [modes] ('memory', 'http') 로 순서대로 돌린다. http 는 [mockUrl] 이 필요하다.
Future<ConformanceReport> runConformance({
  required String testCasesJson,
  List<String> modes = const ['memory', 'http'],
  String? mockUrl,
  bool includeSlow = false,
  String? only,
  bool includeConfigCases = true,
}) async {
  final suite = ConformanceSuite.parse(testCasesJson);
  final cases = suite.cases.where((c) => only == null || c['name'] == only).toList();
  final results = <CaseResult>[];
  for (final mode in modes) {
    MockServerHarness? server;
    if (mode == 'http') {
      if (mockUrl == null) throw ArgumentError('http mode needs mockUrl');
      server = MockServerHarness(mockUrl);
    }
    try {
      for (final c in cases) {
        final name = c['name'] as String;
        final skip = skipReason(c, mode, includeSlow: includeSlow || only != null);
        if (skip != null) {
          results.add(CaseResult.skipped(name, mode, skip));
          continue;
        }
        final sw = Stopwatch()..start();
        List<String> failures;
        try {
          failures = await runConformanceCase(
              suite, c, server ?? MemoryHarness((c['responses'] as Map).cast<String, Object?>()));
        } catch (x, st) {
          failures = ['harness error: $x\n$st'];
        }
        results.add(CaseResult.ran(name, mode, failures, sw.elapsedMilliseconds));
      }
    } finally {
      server?.close();
    }
  }
  final configResults = <String, List<String>>{};
  if (includeConfigCases) {
    for (final c in suite.configCases.where((c) => only == null || c['name'] == only)) {
      configResults[c['name'] as String] = runConfigCase(c);
    }
  }
  return ConformanceReport(results, configResults);
}
