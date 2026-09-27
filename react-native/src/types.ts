import type { AbortSignalLike } from './runtime.js';

/** 시도 결과 (SPEC 4절). 문자열 값은 명세 표 그대로. */
export const Outcome = {
  OK: 'ok',
  BAD_BODY: 'bad_body',
  CONTEXT_EXCEEDED: 'context_exceeded',
  RETRYABLE_STATUS: 'retryable_status',
  FATAL_STATUS: 'fatal_status',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

/** 최종 에러 종류 (SPEC 5절). */
export const ErrorKind = {
  INVALID_REQUEST: 'invalid_request',
  NON_RETRYABLE: 'non_retryable',
  CONTEXT_WINDOW_EXCEEDED: 'context_window_exceeded',
  ALL_FAILED: 'all_failed',
} as const;
export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** OpenAI chat/completions 본문에서 `model` 을 뺀 것. 모르는 필드도 그대로 보낸다. */
export interface ChatRequest {
  messages: unknown[];
  stream?: boolean;
  [field: string]: unknown;
}

export interface Attempt {
  deploymentId: string;
  group: string;
  outcome: Outcome;
  /** HTTP 응답을 받았으면 상태 코드, timeout·network_error 면 null */
  status: number | null;
  /** 실제 경과 시간(단조 시계). 주입된 now 와 무관 */
  durationMs: number;
  message: string | null;
}

export interface RouteResult {
  /** 제공처 응답 JSON 전체 */
  response: JsonObject;
  deploymentId: string;
  /** 실제로 응답한 그룹 (폴백되면 요청 그룹과 다름) */
  group: string;
  attempts: Attempt[];
}

export interface DeploymentState {
  coolingDown: boolean;
  cooldownUntilMs: number | null;
  recentFailures: number;
}

export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /**
   * 라우터가 타임아웃·취소 때 abort 한다. transport 는 즉시 멈춰야 한다.
   * 실제 값은 전역 `new AbortController().signal` 이다(전역이 없을 때만 최소 대용품).
   * DOM/RN 의 `fetch` 에 넘길 때는 `signal as unknown as AbortSignal` 로 캐스팅한다.
   */
  signal: AbortSignalLike;
}

export interface TransportResponse {
  status: number;
  /** 응답 본문 원문 */
  text: string;
}

/**
 * HTTP 요청 한 번. 응답을 못 받으면(연결 실패·끊김) 예외를 던진다.
 * 스스로 재시도하지 않고, 리다이렉트를 따라가지 않으며, 자체 타임아웃을 걸지 않는다 (SPEC 3.6).
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface RouterOptions {
  transport?: Transport;
  /** [0,1) 난수. 기본 Math.random */
  rng?: () => number;
  /** 밀리초 시계. 기본 Date.now (SPEC 1.2) */
  now?: () => number;
}

export interface RouteOptions {
  /** 취소 신호. 취소되면 `signal.reason`(없으면 AbortError)을 던진다 (SPEC 1.1) */
  signal?: AbortSignalLike | undefined;
}
