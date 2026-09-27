import 'dart:async';

/// 호출자 취소 수단 (SPEC 1.1). 한 토큰을 여러 `route` 에 같이 써도 된다.
class CancelToken {
  bool _cancelled = false;
  Completer<void>? _completer;
  final Set<void Function()> _listeners = {};

  bool get isCancelled => _cancelled;

  /// 취소되면 완료되는 Future. 오류로 끝나지 않는다.
  Future<void> get whenCancelled {
    final c = _completer ??= Completer<void>();
    if (_cancelled && !c.isCompleted) c.complete();
    return c.future;
  }

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    final c = _completer;
    if (c != null && !c.isCompleted) c.complete();
    final ls = List.of(_listeners);
    _listeners.clear();
    for (final l in ls) {
      l();
    }
  }

  void throwIfCancelled() {
    if (_cancelled) throw const RouteCancelledException();
  }
}

/// 호출자가 [CancelToken] 으로 취소했을 때 `route` 가 던진다. `RouterError` 가 아니다.
class RouteCancelledException implements Exception {
  const RouteCancelledException();

  @override
  String toString() => 'RouteCancelledException: route cancelled by caller';
}

/// 라이브러리 내부용 (공개 export 안 함): 취소 콜백을 등록하고 해제 함수를 돌려준다.
/// 오래 쓰는 토큰에 시도마다 `whenCancelled.then` 을 붙이면 콜백이 쌓이므로 이걸 쓴다.
void Function() addCancelListener(CancelToken token, void Function() listener) {
  if (token._cancelled) {
    scheduleMicrotask(listener);
    return () {};
  }
  token._listeners.add(listener);
  return () => token._listeners.remove(listener);
}

/// 테스트용: 등록된 콜백 수.
int cancelListenerCount(CancelToken token) => token._listeners.length;
