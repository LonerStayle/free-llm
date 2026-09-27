// 폴백 라우터 (SPEC 1·2·3절). 처리 순서와 rng() 호출 시점은 SPEC 2절 의사코드 그대로다.
import { classifyResponse, estimateTokens, pickWeighted } from './classify.js';
import { normalizeConfig } from './config.js';
import type { Config, DeploymentConfig } from './config.js';
import { RouterError } from './errors.js';
import { abortReason, monotonicMs, newAbortController, startTimer } from './runtime.js';
import type { AbortSignalLike } from './runtime.js';
import { fetchTransport } from './transport.js';
import { ErrorKind, Outcome } from './types.js';
import type {
  Attempt,
  ChatRequest,
  DeploymentState,
  JsonObject,
  RouteOptions,
  RouteResult,
  RouterOptions,
  Transport,
} from './types.js';

type GroupReason = 'context' | 'retryable';

interface DeploymentRecord {
  failures: number[];
  cooldownUntil: number | null;
}

type SendResult =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'error'; outcome: 'timeout' | 'network_error'; message: string };

function throwIfCancelled(signal: AbortSignalLike | undefined): void {
  if (signal && signal.aborted) throw abortReason(signal);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export class Router {
  private readonly config: Config;
  private readonly keys: ReadonlyMap<string, string>;
  private readonly transport: Transport;
  private readonly rng: () => number;
  private readonly now: () => number;
  // 배포 id → 실패 기록·쿨다운. 메모리에만, 인스턴스 단위 (SPEC 1절)
  private readonly state = new Map<string, DeploymentRecord>();

  /**
   * @param config parseConfig 결과, 또는 models.json 형식 객체(생성자에서 검사한다. 잘못되면 ConfigError)
   * @param keys   providerId → API 키. 없거나 빈 문자열인 제공처의 배포는 후보에서 빠진다
   */
  constructor(config: Config | object, keys: Readonly<Record<string, string>> | ReadonlyMap<string, string> = {}, options: RouterOptions = {}) {
    this.config = normalizeConfig(config);
    this.keys = keys instanceof Map ? new Map(keys) : new Map(Object.entries(keys as Record<string, string>));
    this.transport = options.transport ?? fetchTransport();
    this.rng = options.rng ?? Math.random;
    this.now = options.now ?? Date.now; // RN 기본은 벽시계 (SPEC 1.2)
  }

  get settings(): Config['settings'] {
    return this.config.settings;
  }

  /**
   * group 으로 요청을 보낸다. 실패하면 RouterError, 취소되면 `signal.reason`(없으면 AbortError)을 던진다.
   */
  async route(group: string, request: ChatRequest, options: RouteOptions = {}): Promise<RouteResult> {
    const { signal } = options;
    const attempts: Attempt[] = [];
    if (typeof group !== 'string' || !this.config.groups.has(group)) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, `unknown group: ${String(group)}`, { attempts });
    }
    const req = request as unknown;
    if (req === null || typeof req !== 'object' || Array.isArray(req) || !Array.isArray((req as ChatRequest).messages)) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, 'request.messages must be an array', { attempts });
    }
    if (request.stream === true) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, 'stream is not supported', { attempts });
    }
    const tokens = estimateTokens(request);
    const attempted = new Set<string>();
    const visited: string[] = [];
    const queue: string[] = [group];
    const reasons: GroupReason[] = [];
    const { fallbacks, contextWindowFallbacks } = this.config.settings;
    while (queue.length > 0) {
      const g = queue.shift()!;
      visited.push(g);
      const r = await this.runGroup(g, request, tokens, attempted, attempts, signal);
      if (typeof r !== 'string') return r;
      reasons.push(r);
      const next = (r === 'context' ? contextWindowFallbacks.get(g) : fallbacks.get(g)) ?? [];
      for (const n of next) if (!visited.includes(n) && !queue.includes(n)) queue.push(n);
    }
    const kind = reasons.every((x) => x === 'context') ? ErrorKind.CONTEXT_WINDOW_EXCEEDED : ErrorKind.ALL_FAILED;
    throw new RouterError(kind, `all deployments failed (groups: ${visited.join(' -> ')})`, { attempts });
  }

  /** 오프라인 뒤 회복용: 모든 배포의 실패 기록·쿨다운을 비운다 (SPEC 1.4). 진행 중인 route 는 그대로 진행한다. */
  resetState(): void {
    this.state.clear();
  }

  /** 진단·테스트용. 설정의 모든 배포(비활성·키 없음 포함). */
  deploymentStates(): Record<string, DeploymentState> {
    const now = this.now();
    const windowMs = this.config.settings.cooldownMs;
    const out: Record<string, DeploymentState> = {};
    for (const list of this.config.groups.values()) {
      for (const d of list) {
        const s = this.state.get(d.id);
        const cooling = this.isCoolingDown(d.id, now);
        out[d.id] = {
          coolingDown: cooling,
          cooldownUntilMs: cooling && s ? s.cooldownUntil : null,
          recentFailures: s ? s.failures.filter((t) => now - t < windowMs).length : 0,
        };
      }
    }
    return out;
  }

  // ── 내부 ───────────────────────────────────────────

  private record(id: string): DeploymentRecord {
    let s = this.state.get(id);
    if (!s) {
      s = { failures: [], cooldownUntil: null };
      this.state.set(id, s);
    }
    return s;
  }

  private isCoolingDown(id: string, now: number): boolean {
    const s = this.state.get(id);
    return s !== undefined && s.cooldownUntil !== null && now < s.cooldownUntil;
  }

  // 쿨다운 중에 늦게 도착한 실패도 그대로 센다(SPEC 1.3, 3.4).
  private recordFailure(id: string, now: number): void {
    const s = this.record(id);
    const windowMs = this.config.settings.cooldownMs;
    s.failures = s.failures.filter((t) => now - t < windowMs);
    s.failures.push(now);
    if (s.failures.length >= this.config.settings.allowedFails) {
      s.cooldownUntil = now + windowMs;
      s.failures = [];
    }
  }

  private key(providerId: string): string | null {
    const k = this.keys.get(providerId);
    return typeof k === 'string' && k.length > 0 ? k : null;
  }

  private candidates(group: string, tokens: number, attempted: ReadonlySet<string>, now: number) {
    const cands: DeploymentConfig[] = [];
    let tokenExcluded = false;
    for (const d of this.config.groups.get(group) ?? []) {
      if (!d.enabled) continue;
      if (this.key(d.provider) === null) continue;
      if (this.isCoolingDown(d.id, now)) continue;
      if (attempted.has(d.id)) continue;
      if (d.maxInputTokens !== null && tokens > d.maxInputTokens) {
        tokenExcluded = true;
        continue;
      }
      cands.push(d);
    }
    return { cands, tokenExcluded };
  }

  /** 성공이면 RouteResult, 그룹을 끝내면 종료 사유. fatal 이면 RouterError 를 던진다. */
  private async runGroup(
    group: string,
    request: ChatRequest,
    tokens: number,
    attempted: Set<string>,
    attempts: Attempt[],
    signal: AbortSignalLike | undefined,
  ): Promise<RouteResult | GroupReason> {
    const maxAttempts = 1 + this.config.settings.numRetries;
    let n = 0;
    let last: GroupReason = 'retryable';
    let tokenExcludedAtStart = false;
    while (n < maxAttempts) {
      throwIfCancelled(signal); // (1) 매 시도 직전, 후보 계산·rng 전
      const { cands, tokenExcluded } = this.candidates(group, tokens, attempted, this.now());
      if (cands.length === 0) {
        if (n === 0) tokenExcludedAtStart = tokenExcluded;
        break;
      }
      const d = pickWeighted(cands, this.rng);
      attempted.add(d.id);
      n++;
      const started = monotonicMs();
      const r = await this.send(d, request, signal); // 취소되면 여기서 취소 예외가 그대로 올라간다
      const durationMs = Math.round(monotonicMs() - started);

      if (r.kind === 'error') {
        attempts.push({ deploymentId: d.id, group, outcome: r.outcome, status: null, durationMs, message: r.message });
        this.recordFailure(d.id, this.now());
        last = 'retryable';
        continue;
      }
      const c = classifyResponse(r.status, r.text);
      attempts.push({ deploymentId: d.id, group, outcome: c.outcome, status: r.status, durationMs, message: null });
      switch (c.outcome) {
        case Outcome.OK:
          return { response: c.json as JsonObject, deploymentId: d.id, group, attempts };
        case Outcome.FATAL_STATUS:
          throw new RouterError(ErrorKind.NON_RETRYABLE, `${d.id} returned ${r.status}`, {
            status: r.status,
            body: r.text,
            attempts,
          });
        case Outcome.CONTEXT_EXCEEDED:
          last = 'context'; // 실패 기록 안 함
          break;
        default: // retryable_status, bad_body
          this.recordFailure(d.id, this.now());
          last = 'retryable';
      }
    }
    if (n > 0) return last;
    return tokenExcludedAtStart ? 'context' : 'retryable';
  }

  /**
   * 시도 한 번 (SPEC 3.6). 응답 본문까지 timeoutMs 안에 받아야 한다.
   * 호출자 취소는 결과가 아니라 예외다: transport 가 취소 때문에 실패해도 network_error 로 바꾸지 않는다 (SPEC 1.1).
   */
  private send(d: DeploymentConfig, request: ChatRequest, signal: AbortSignalLike | undefined): Promise<SendResult> {
    const provider = this.config.providers.get(d.provider)!;
    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.key(d.provider) ?? ''}`,
      ...provider.extraHeaders,
    };
    const body = JSON.stringify({ ...request, model: d.model });
    const timeoutMs = this.config.settings.timeoutMs;
    const ctrl = newAbortController();

    return new Promise<SendResult>((resolve, reject) => {
      let settled = false;
      let stopTimer = () => {};
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        stopTimer();
        signal?.removeEventListener('abort', onCancel);
        settle();
      };
      // (2) 시도 중 취소: transport 를 즉시 끊고 응답을 기다리지 않는다
      const onCancel = () => {
        ctrl.abort();
        finish(() => reject(abortReason(signal!)));
      };
      stopTimer = startTimer(timeoutMs, () => {
        ctrl.abort();
        finish(() => resolve({ kind: 'error', outcome: 'timeout', message: `no complete response within ${timeoutMs}ms` }));
      });
      signal?.addEventListener('abort', onCancel, { once: true });
      if (signal?.aborted) onCancel(); // 등록 전에 이미 취소됐으면 이벤트가 오지 않는다
      if (settled) return;

      const transport = this.transport;
      let pending: Promise<{ status: number; text: string }>;
      try {
        pending = Promise.resolve(transport({ url, headers, body, signal: ctrl.signal }));
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.then(
        (res) => {
          // (3) transport 가 끝난 직후, 분류 전
          if (signal?.aborted) return finish(() => reject(abortReason(signal)));
          finish(() => resolve({ kind: 'response', status: res.status, text: res.text }));
        },
        (e: unknown) => {
          if (signal?.aborted) return finish(() => reject(abortReason(signal)));
          finish(() => resolve({ kind: 'error', outcome: 'network_error', message: messageOf(e) }));
        },
      );
    });
  }
}
