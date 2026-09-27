// 런타임 전역(fetch·AbortController·setTimeout·performance)을 DOM/Node 타입 없이 쓰기 위한 최소 타입.
// RN(Hermes)·Node·브라우저 어디서나 전역으로 있는 것만 쓴다.

/** 호출자가 넘기는 취소 신호. DOM·Node·RN 폴리필의 `AbortSignal` 이 모두 이 모양을 만족한다. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  /** Hermes 의 오래된 폴리필은 `reason` 이 없을 수 있다. */
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignalLike;
  redirect?: 'manual' | 'follow' | 'error';
}

export interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

interface RuntimeGlobals {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController?: new () => AbortControllerLike;
  fetch?: FetchLike;
  performance?: { now(): number };
}

const g = globalThis as unknown as RuntimeGlobals;

/** 호출 시점의 전역 fetch (폴리필이 나중에 깔려도 잡히게 늦게 찾는다). */
export function globalFetch(): FetchLike {
  if (typeof g.fetch !== 'function') throw new Error('global fetch is not available');
  return (url, init) => g.fetch!(url, init);
}

/** 단조 시계(ms). durationMs 전용. 없으면 Date.now. */
export function monotonicMs(): number {
  return g.performance && typeof g.performance.now === 'function' ? g.performance.now() : Date.now();
}

// setTimeout 은 2^31-1 ms 를 넘으면 즉시 실행되는 런타임이 많다. 긴 대기는 나눠 건다.
const MAX_TIMER_MS = 2147483647;

/** ms 뒤 callback. 돌려준 함수를 부르면 취소. */
export function startTimer(ms: number, callback: () => void): () => void {
  let handle: unknown = null;
  let cancelled = false;
  const arm = (remaining: number) => {
    const step = Math.min(Math.max(remaining, 0), MAX_TIMER_MS);
    handle = g.setTimeout(() => {
      if (cancelled) return;
      if (remaining > step) arm(remaining - step);
      else callback();
    }, step);
  };
  arm(ms);
  return () => {
    cancelled = true;
    g.clearTimeout(handle);
  };
}

/** 전역 AbortController, 없으면 transport 에 넘길 최소 대용품. */
export function newAbortController(): AbortControllerLike {
  if (typeof g.AbortController === 'function') return new g.AbortController();
  return new MiniAbortController();
}

class MiniAbortController implements AbortControllerLike {
  private readonly listeners = new Set<() => void>();
  private state: { aborted: boolean; reason: unknown } = { aborted: false, reason: undefined };
  readonly signal: AbortSignalLike;

  constructor() {
    const self = this;
    this.signal = {
      get aborted() {
        return self.state.aborted;
      },
      get reason() {
        return self.state.reason;
      },
      addEventListener: (_type, listener) => {
        self.listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        self.listeners.delete(listener);
      },
    };
  }

  abort(reason?: unknown): void {
    if (this.state.aborted) return;
    this.state = { aborted: true, reason: reason === undefined ? new AbortError() : reason };
    const list = [...this.listeners];
    this.listeners.clear();
    for (const l of list) l();
  }
}

/**
 * 취소 예외. 호출자 신호에 `reason` 이 없을 때(Hermes 의 오래된 AbortController 폴리필 등) 대신 던진다.
 * `name` 이 DOMException 과 같은 'AbortError' 라서 `e.name === 'AbortError'` 로 구분할 수 있다.
 */
export class AbortError extends Error {
  constructor(message = 'This operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 취소된 신호에서 던질 값: `signal.reason`, 없으면 AbortError. */
export function abortReason(signal: AbortSignalLike): unknown {
  return signal.reason !== undefined ? signal.reason : new AbortError();
}
