/// 무료 LLM 폴백 라우터 (순수 Dart). 명세: spec/SPEC.md.
library;

export 'src/cancel.dart' show CancelToken, RouteCancelledException;
export 'src/config.dart' show Config, DeploymentConfig, ProviderConfig, RouterSettings, parseConfig;
export 'src/router.dart' show LlmRouter;
export 'src/rules.dart' show estimateTokens;
export 'src/transport.dart' show HttpTransport, Transport, TransportResponse;
export 'src/types.dart'
    show Attempt, ConfigError, DeploymentState, ErrorKind, Outcome, RouteResult, RouterError;
