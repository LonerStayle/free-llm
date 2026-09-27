/// 시도 결과 종류 (SPEC 4절). [value] 가 명세의 문자열 값.
enum Outcome {
  ok('ok'),
  retryableStatus('retryable_status'),
  badBody('bad_body'),
  timeout('timeout'),
  networkError('network_error'),
  contextExceeded('context_exceeded'),
  fatalStatus('fatal_status');

  const Outcome(this.value);
  final String value;

  @override
  String toString() => value;
}

/// 최종 에러 종류 (SPEC 5절). [value] 가 명세의 문자열 값.
enum ErrorKind {
  invalidRequest('invalid_request'),
  nonRetryable('non_retryable'),
  contextWindowExceeded('context_window_exceeded'),
  allFailed('all_failed');

  const ErrorKind(this.value);
  final String value;

  @override
  String toString() => value;
}

/// 시도(HTTP 요청 한 번) 기록.
class Attempt {
  const Attempt({
    required this.deploymentId,
    required this.group,
    required this.outcome,
    required this.status,
    required this.durationMs,
    required this.message,
  });

  final String deploymentId;
  final String group;
  final Outcome outcome;

  /// HTTP 응답을 받았으면 상태 코드, `timeout`·`network_error` 면 null.
  final int? status;

  /// 실제 경과 시간 (단조 시계, 주입된 now 와 무관).
  final int durationMs;
  final String? message;

  @override
  String toString() => 'Attempt($deploymentId, $group, ${outcome.value}, status=$status, ${durationMs}ms'
      '${message == null ? '' : ', $message'})';
}

class RouteResult {
  const RouteResult({
    required this.response,
    required this.deploymentId,
    required this.group,
    required this.attempts,
  });

  /// 제공처 응답 JSON 전체.
  final Map<String, Object?> response;
  final String deploymentId;

  /// 실제로 응답한 그룹 (폴백되면 요청 그룹과 다르다).
  final String group;
  final List<Attempt> attempts;
}

/// 라우팅 실패 (SPEC 5절). 호출자 취소는 이것이 아니라 `RouteCancelledException`.
class RouterError implements Exception {
  RouterError(
    this.kind,
    this.message, {
    this.status,
    this.body,
    List<Attempt> attempts = const [],
  }) : attempts = List.unmodifiable(attempts);

  final ErrorKind kind;
  final String message;
  final int? status;

  /// `non_retryable` 일 때만 응답 본문 원문.
  final String? body;
  final List<Attempt> attempts;

  @override
  String toString() => 'RouterError(${kind.value}${status == null ? '' : ', $status'}): $message';
}

/// 설정 오류 (`parseConfig`).
class ConfigError implements Exception {
  const ConfigError(this.message);
  final String message;

  @override
  String toString() => 'ConfigError: $message';
}

class DeploymentState {
  const DeploymentState({
    required this.coolingDown,
    required this.cooldownUntilMs,
    required this.recentFailures,
  });

  final bool coolingDown;

  /// [coolingDown] 일 때만 값이 있다.
  final int? cooldownUntilMs;
  final int recentFailures;

  @override
  String toString() =>
      'DeploymentState(coolingDown=$coolingDown, cooldownUntilMs=$cooldownUntilMs, recentFailures=$recentFailures)';
}
