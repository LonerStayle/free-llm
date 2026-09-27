import 'dart:convert';

import 'package:http/http.dart' as http;

import 'cancel.dart';

class TransportResponse {
  const TransportResponse(this.status, this.text);
  final int status;

  /// 응답 본문 원문.
  final String text;
}

/// HTTP 요청 한 번을 보내는 수단 (SPEC 1절, 3.6).
///
/// - 응답을 못 받으면(연결 실패·끊김) 예외를 던진다.
/// - [cancel] 이 취소되면 진행 중인 요청을 중단해야 한다(라우터의 타임아웃·호출자 취소).
/// - 스스로 재시도하지 않고 리다이렉트를 따라가지 않는다. 타임아웃은 라우터가 건다.
abstract interface class Transport {
  Future<TransportResponse> send(
    String url,
    Map<String, String> headers,
    String body,
    CancelToken cancel,
  );
}

/// 기본 transport: `package:http` (모바일·VM 에서는 dart:io 기반 IOClient).
///
/// 요청마다 `followRedirects = false`, 자체 타임아웃 없음, 재시도 없음.
/// 취소는 [http.AbortableRequest] 로 소켓까지 끊는다.
class HttpTransport implements Transport {
  /// [client] 를 주지 않으면 `http.Client()` 를 만든다 (`runWithClient` 설정을 따른다).
  HttpTransport({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<TransportResponse> send(
    String url,
    Map<String, String> headers,
    String body,
    CancelToken cancel,
  ) async {
    final req = http.AbortableRequest('POST', Uri.parse(url), abortTrigger: cancel.whenCancelled)
      ..followRedirects = false
      ..headers.addAll(headers)
      // body 대신 bodyBytes: Content-Type 에 charset 을 덧붙이지 않는다.
      ..bodyBytes = utf8.encode(body);
    final res = await _client.send(req);
    final bytes = await res.stream.toBytes();
    return TransportResponse(res.statusCode, utf8.decode(bytes, allowMalformed: true));
  }

  void close() => _client.close();
}
