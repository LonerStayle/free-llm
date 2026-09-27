import type { Attempt, ErrorKind } from './types.js';

/** 설정(models.json)이 잘못됨. 라우팅 에러가 아니다. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** route 실패 (SPEC 5절). 호출자 취소는 이것이 아니라 취소 예외다. */
export class RouterError extends Error {
  readonly kind: ErrorKind;
  /** non_retryable 일 때 그 상태 코드, 그 외 null */
  readonly status: number | null;
  /** non_retryable 일 때 응답 본문 원문, 그 외 null */
  readonly body: string | null;
  readonly attempts: readonly Attempt[];

  constructor(kind: ErrorKind, message: string, detail: { status?: number | null; body?: string | null; attempts?: Attempt[] } = {}) {
    super(message);
    this.name = 'RouterError';
    this.kind = kind;
    this.status = detail.status ?? null;
    this.body = detail.body ?? null;
    this.attempts = detail.attempts ?? [];
  }
}
