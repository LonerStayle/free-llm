import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'cancel.dart';
import 'config.dart';
import 'rules.dart';
import 'transport.dart';
import 'types.dart';

class _DeploymentStateRecord {
  List<int> failures = [];
  int? cooldownUntil;
}

class _SendResult {
  _SendResult.response(int this.status, String this.text)
      : error = null,
        message = null;
  _SendResult.error(Outcome this.error, String this.message)
      : status = null,
        text = null;

  final int? status;
  final String? text;
  final Outcome? error; // timeout | networkError
  final String? message;
}

class _GroupEnd {
  const _GroupEnd.ok(RouteResult this.result) : reason = null;
  const _GroupEnd.failed(String this.reason) : result = null;
  final RouteResult? result;
  final String? reason; // 'context' | 'retryable'
}

/// 폴백 라우터 (SPEC 1절). 상태(실패 기록·쿨다운)는 이 인스턴스 메모리에만 있다.
///
/// Flutter 의 `Router` 위젯과 이름이 겹치지 않도록 `LlmRouter` 라고 부른다(SPEC 1절: 이름은 언어 관례).
class LlmRouter {
  /// [keys]: providerId → API 키. 없거나 빈 문자열인 제공처의 배포는 건너뛴다.
  /// [transport] 를 주지 않으면 이 라우터 전용 [HttpTransport] 를 만든다([close] 로 닫는다).
  /// [rng] 는 [0,1). [now] 는 밀리초 (기본 벽시계, SPEC 1.2).
  LlmRouter(
    this.config,
    Map<String, String> keys, {
    Transport? transport,
    double Function()? rng,
    int Function()? now,
  })  : _keys = Map.of(keys),
        _transport = transport ?? HttpTransport(),
        _ownsTransport = transport == null,
        _rng = rng ?? math.Random().nextDouble,
        _now = now ?? _wallClockMs;

  final Config config;
  final Map<String, String> _keys;
  final Transport _transport;
  final bool _ownsTransport;
  final double Function() _rng;
  final int Function() _now;
  final Map<String, _DeploymentStateRecord> _state = {};

  static int _wallClockMs() => DateTime.now().millisecondsSinceEpoch;

  RouterSettings get settings => config.settings;

  _DeploymentStateRecord _st(String id) => _state.putIfAbsent(id, _DeploymentStateRecord.new);

  bool _isCoolingDown(String id, int now) {
    final until = _st(id).cooldownUntil;
    return until != null && now < until;
  }

  void _recordFailure(String id, int now) {
    final s = _st(id);
    final windowMs = settings.cooldownMs;
    // 쿨다운 중에 도착한 실패도 그대로 기록한다 (SPEC 1.3, 3.4).
    s.failures = s.failures.where((t) => now - t < windowMs).toList()..add(now);
    if (s.failures.length >= settings.allowedFails) {
      s.cooldownUntil = now + windowMs;
      s.failures = [];
    }
  }

  String? _key(String providerId) {
    final k = _keys[providerId];
    return k != null && k.isNotEmpty ? k : null;
  }

  /// 기본 transport(생성자에서 [transport] 를 안 준 경우)의 연결을 닫는다. 주입한 transport 는 닫지 않는다.
  /// Dart CLI 에서는 끝날 때 부르면 keep-alive 소켓 때문에 프로세스가 늦게 끝나는 일이 없다.
  /// 닫은 뒤 route 는 network_error 로 실패한다.
  void close() {
    final t = _transport;
    if (_ownsTransport && t is HttpTransport) t.close();
  }

  /// 오프라인 뒤 회복용: 모든 배포의 실패 기록·쿨다운을 비운다 (SPEC 1.4).
  /// 진행 중인 route 는 그대로 진행하고, 그 뒤 실패는 새로 쌓인다.
  void resetState() => _state.clear();

  /// 설정의 모든 배포(비활성·키 없음 포함) 상태. 진단·테스트용.
  Map<String, DeploymentState> deploymentStates() {
    final now = _now();
    final windowMs = settings.cooldownMs;
    final out = <String, DeploymentState>{};
    for (final list in config.groups.values) {
      for (final d in list) {
        final s = _st(d.id);
        final cooling = _isCoolingDown(d.id, now);
        out[d.id] = DeploymentState(
          coolingDown: cooling,
          cooldownUntilMs: cooling ? s.cooldownUntil : null,
          recentFailures: s.failures.where((t) => now - t < windowMs).length,
        );
      }
    }
    return out;
  }

  /// [group] 으로 요청한다. 실패하면 [RouterError], [cancelToken] 으로 취소하면 [RouteCancelledException].
  /// [request] 는 OpenAI chat/completions 본문 (`model` 은 배포 것으로 덮어쓴다).
  Future<RouteResult> route(
    String group,
    Map<String, Object?> request, {
    CancelToken? cancelToken,
  }) async {
    final attempts = <Attempt>[];
    if (!config.groups.containsKey(group)) {
      throw RouterError(ErrorKind.invalidRequest, 'unknown group: $group', attempts: attempts);
    }
    if (request['messages'] is! List) {
      throw RouterError(ErrorKind.invalidRequest, 'request.messages must be an array', attempts: attempts);
    }
    if (request['stream'] == true) {
      throw RouterError(ErrorKind.invalidRequest, 'stream is not supported', attempts: attempts);
    }
    final tokens = estimateTokens(request);
    final attempted = <String>{};
    final visited = <String>{};
    final queue = <String>[group];
    final reasons = <String>[];
    while (queue.isNotEmpty) {
      final g = queue.removeAt(0);
      visited.add(g);
      final r = await _runGroup(g, request, tokens, attempted, attempts, cancelToken);
      if (r.result != null) return r.result!;
      final reason = r.reason!;
      reasons.add(reason);
      final next =
          (reason == 'context' ? settings.contextWindowFallbacks[g] : settings.fallbacks[g]) ?? const [];
      for (final n in next) {
        if (!visited.contains(n) && !queue.contains(n)) queue.add(n);
      }
    }
    final kind = reasons.every((x) => x == 'context') ? ErrorKind.contextWindowExceeded : ErrorKind.allFailed;
    throw RouterError(kind, 'all deployments failed (groups: ${visited.join(' → ')})', attempts: attempts);
  }

  Future<_GroupEnd> _runGroup(
    String group,
    Map<String, Object?> request,
    int tokens,
    Set<String> attempted,
    List<Attempt> attempts,
    CancelToken? cancel,
  ) async {
    final maxAttempts = 1 + settings.numRetries;
    var n = 0;
    String? last;
    var tokenExcludedAtStart = false;
    while (n < maxAttempts) {
      cancel?.throwIfCancelled(); // 매 시도 직전 (후보 계산·rng 전)
      final now = _now();
      final candidates = <DeploymentConfig>[];
      var tokenExcluded = false;
      for (final d in config.groups[group]!) {
        if (!d.enabled) continue;
        if (_key(d.provider) == null) continue;
        if (_isCoolingDown(d.id, now)) continue;
        if (attempted.contains(d.id)) continue;
        if (d.maxInputTokens != null && tokens > d.maxInputTokens!) {
          tokenExcluded = true;
          continue;
        }
        candidates.add(d);
      }
      if (candidates.isEmpty) {
        if (n == 0) tokenExcludedAtStart = tokenExcluded;
        break;
      }
      final d = pickWeighted(candidates, _rng);
      attempted.add(d.id);
      n++;
      final sw = Stopwatch()..start();
      final r = await _send(d, request, cancel);
      Outcome outcome;
      int? status;
      String? message;
      Map<String, Object?>? json;
      if (r.error != null) {
        outcome = r.error!;
        message = r.message;
      } else {
        final c = classifyResponse(r.status!, r.text!);
        outcome = c.outcome;
        status = r.status;
        json = c.json;
      }
      attempts.add(Attempt(
        deploymentId: d.id,
        group: group,
        outcome: outcome,
        status: status,
        durationMs: sw.elapsedMilliseconds,
        message: message,
      ));
      switch (outcome) {
        case Outcome.ok:
          return _GroupEnd.ok(RouteResult(
            response: json!,
            deploymentId: d.id,
            group: group,
            attempts: List.unmodifiable(attempts),
          ));
        case Outcome.fatalStatus:
          throw RouterError(
            ErrorKind.nonRetryable,
            '${d.id} returned ${r.status}',
            status: r.status,
            body: r.text,
            attempts: attempts,
          );
        case Outcome.contextExceeded:
          last = 'context';
        case Outcome.retryableStatus || Outcome.badBody || Outcome.timeout || Outcome.networkError:
          _recordFailure(d.id, _now());
          last = 'retryable';
      }
    }
    return _GroupEnd.failed(n > 0 ? last! : (tokenExcludedAtStart ? 'context' : 'retryable'));
  }

  // 한 시도. 타임아웃이면 timeout, transport 예외면 network_error.
  // 호출자 취소면 RouteCancelledException 을 던진다 (network_error 로 바꾸지 않는다, SPEC 1.1).
  Future<_SendResult> _send(DeploymentConfig d, Map<String, Object?> request, CancelToken? cancel) async {
    final p = config.providers[d.provider]!;
    final url = '${p.baseUrl.replaceFirst(RegExp(r'/+$'), '')}/chat/completions';
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${_key(d.provider)}',
      ...p.extraHeaders,
    };
    final body = jsonEncode({...request, 'model': d.model});

    final attemptToken = CancelToken(); // transport 를 끊는 용도 (타임아웃·호출자 취소)
    final done = Completer<_SendResult>();
    var timedOut = false;
    final timer = Timer(Duration(milliseconds: settings.timeoutMs), () {
      timedOut = true;
      attemptToken.cancel();
      if (!done.isCompleted) done.complete(_SendResult.error(Outcome.timeout, 'timeout'));
    });
    void Function()? unlisten;
    if (cancel != null) {
      unlisten = addCancelListener(cancel, () {
        attemptToken.cancel();
        if (!done.isCompleted) done.completeError(const RouteCancelledException());
      });
    }
    try {
      _transport.send(url, headers, body, attemptToken).then(
        (res) {
          if (!done.isCompleted) done.complete(_SendResult.response(res.status, res.text));
        },
        onError: (Object e, StackTrace _) {
          if (!done.isCompleted) {
            done.complete(_SendResult.error(timedOut ? Outcome.timeout : Outcome.networkError, '$e'));
          }
        },
      );
    } catch (e) {
      // transport 가 Future 를 돌려주기 전에 동기적으로 던진 경우
      if (!done.isCompleted) done.complete(_SendResult.error(Outcome.networkError, '$e'));
    }
    try {
      final r = await done.future;
      cancel?.throwIfCancelled(); // transport 가 끝난 직후, 분류 전
      return r;
    } finally {
      timer.cancel();
      unlisten?.call();
    }
  }
}
