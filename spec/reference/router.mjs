// free-llm-router 참조 구현 (Node ESM, 의존성 없음).
// 명세: ../SPEC.md. 네 플랫폼 구현은 이 파일과 같은 결과를 내야 한다.

export const DEFAULT_SETTINGS = Object.freeze({
  numRetries: 3,
  allowedFails: 3,
  cooldownSeconds: 60,
  timeoutSeconds: 60,
  fallbacks: {},
  contextWindowFallbacks: {},
});

export const CONTEXT_PATTERNS = Object.freeze([
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
]);

// 시도 결과 종류 (SPEC.md 4절)
export const Outcome = Object.freeze({
  OK: 'ok',
  RETRYABLE_STATUS: 'retryable_status',
  BAD_BODY: 'bad_body',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  CONTEXT_EXCEEDED: 'context_exceeded',
  FATAL_STATUS: 'fatal_status',
});

// 최종 에러 종류 (SPEC.md 5절)
export const ErrorKind = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  NON_RETRYABLE: 'non_retryable',
  CONTEXT_WINDOW_EXCEEDED: 'context_window_exceeded',
  ALL_FAILED: 'all_failed',
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RouterError extends Error {
  constructor(kind, message, { status = null, body = null, attempts = [] } = {}) {
    super(message);
    this.name = 'RouterError';
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.attempts = attempts;
  }
}

// ── 설정 (SPEC.md 6절) ────────────────────────────────
// 모든 레벨에서 모르는 키는 무시한다. 선택 필드가 null 이면 없는 것으로 본다.

const INT_MAX = 2147483647;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// 정수 = JSON 수 중 소수부가 0 인 것 (4, 4.0 모두 4). JSON.parse 는 4.0 을 4 로 읽는다.
const isInt = (v, min) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= INT_MAX;
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

// parseConfig(text): models.json 형식 문자열 → Config. 잘못되면 ConfigError.
export function parseConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid JSON: ${e.message}`);
  }
  return normalizeConfig(raw);
}

export function normalizeConfig(raw) {
  if (!isObj(raw)) throw new ConfigError('config must be an object');
  if (raw.version != null && raw.version !== 1) throw new ConfigError(`unsupported version: ${raw.version}`);
  if (!Array.isArray(raw.providers)) throw new ConfigError('providers must be an array');
  const providers = new Map();
  for (const p of raw.providers) {
    if (!isObj(p)) throw new ConfigError('provider must be an object');
    if (!nonEmptyStr(p.id)) throw new ConfigError('provider.id required');
    if (providers.has(p.id)) throw new ConfigError(`duplicate provider id: ${p.id}`);
    if (!nonEmptyStr(p.baseUrl)) throw new ConfigError(`provider ${p.id}: baseUrl required`);
    if (p.keyName != null && typeof p.keyName !== 'string') throw new ConfigError(`provider ${p.id}: keyName must be a string`);
    const extra = p.extraHeaders ?? {};
    if (!isObj(extra)) throw new ConfigError(`provider ${p.id}: extraHeaders must be an object`);
    for (const [h, v] of Object.entries(extra)) {
      if (/^(authorization|content-type)$/i.test(h)) throw new ConfigError(`provider ${p.id}: extraHeaders must not set ${h}`);
      if (typeof v !== 'string') throw new ConfigError(`provider ${p.id}: extraHeaders.${h} must be a string`);
    }
    providers.set(p.id, { id: p.id, baseUrl: p.baseUrl, keyName: p.keyName ?? null, extraHeaders: { ...extra } });
  }
  if (!isObj(raw.groups)) throw new ConfigError('groups must be an object');
  const groups = {};
  const seen = new Set();
  for (const [name, g] of Object.entries(raw.groups)) {
    if (!isObj(g) || !Array.isArray(g.deployments)) throw new ConfigError(`group ${name}: deployments must be an array`);
    groups[name] = g.deployments.map((d) => {
      if (!isObj(d)) throw new ConfigError(`group ${name}: deployment must be an object`);
      if (!nonEmptyStr(d.id)) throw new ConfigError(`group ${name}: deployment.id required`);
      if (seen.has(d.id)) throw new ConfigError(`duplicate deployment id: ${d.id}`);
      seen.add(d.id);
      if (typeof d.provider !== 'string' || !providers.has(d.provider)) throw new ConfigError(`deployment ${d.id}: unknown provider ${d.provider}`);
      if (!nonEmptyStr(d.model)) throw new ConfigError(`deployment ${d.id}: model required`);
      if (!isInt(d.rpm, 1)) throw new ConfigError(`deployment ${d.id}: rpm must be an integer in [1, ${INT_MAX}]`);
      if (d.maxInputTokens != null && !isInt(d.maxInputTokens, 1)) {
        throw new ConfigError(`deployment ${d.id}: maxInputTokens must be an integer in [1, ${INT_MAX}]`);
      }
      if (d.enabled != null && typeof d.enabled !== 'boolean') throw new ConfigError(`deployment ${d.id}: enabled must be a boolean`);
      return {
        id: d.id,
        provider: d.provider,
        model: d.model,
        rpm: d.rpm,
        maxInputTokens: d.maxInputTokens ?? null,
        enabled: d.enabled ?? true,
      };
    });
  }
  const rs = raw.settings ?? {};
  if (!isObj(rs)) throw new ConfigError('settings must be an object');
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (rs[k] != null) s[k] = rs[k];
  if (!isInt(s.numRetries, 0)) throw new ConfigError('settings.numRetries must be an integer >= 0');
  if (!isInt(s.allowedFails, 1)) throw new ConfigError('settings.allowedFails must be an integer >= 1');
  for (const k of ['cooldownSeconds', 'timeoutSeconds']) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || !(s[k] > 0)) throw new ConfigError(`settings.${k} must be a number > 0`);
  }
  for (const k of ['fallbacks', 'contextWindowFallbacks']) {
    if (!isObj(s[k])) throw new ConfigError(`settings.${k} must be an object`);
    for (const [from, list] of Object.entries(s[k])) {
      if (!(from in groups)) throw new ConfigError(`settings.${k}: unknown group ${from}`);
      if (!Array.isArray(list)) throw new ConfigError(`settings.${k}.${from} must be an array`);
      for (const to of list) if (typeof to !== 'string' || !(to in groups)) throw new ConfigError(`settings.${k}.${from}: unknown group ${to}`);
    }
  }
  // 초 → 밀리초: 가장 가까운 정수로 반올림 (양수라 .5 는 올림)
  s.cooldownMs = Math.round(s.cooldownSeconds * 1000);
  s.timeoutMs = Math.round(s.timeoutSeconds * 1000);
  return { providers, groups, settings: s };
}

// ── 토큰 추정 (SPEC.md 3.1) ───────────────────────────
// JS string.length 는 UTF-16 코드 유닛 수 → 명세와 같다.

export function estimateTokens(request) {
  let units = 0;
  for (const m of request.messages) {
    const c = m?.content;
    if (typeof c === 'string') units += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) if (part && typeof part.text === 'string') units += part.text.length;
    }
  }
  return Math.floor((units + 3) / 4);
}

// ── 응답 분류 (SPEC.md 4절) ───────────────────────────

export function isRetryableStatus(status) {
  return status === 404 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// ASCII A–Z 만 a–z 로 바꾼다. 로캘·유니코드 소문자화를 쓰지 않는다 (SPEC.md 4절).
export function asciiLower(text) {
  return String(text ?? '').replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isContextError(status, text) {
  if (status !== 400 && status !== 413) return false;
  const lower = asciiLower(text);
  return CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

// → { outcome, json }
export function classifyResponse(status, text) {
  if (status >= 200 && status <= 299) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { outcome: Outcome.BAD_BODY, json: null };
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return { outcome: Outcome.BAD_BODY, json: null };
    if (json.error != null) return { outcome: Outcome.BAD_BODY, json };
    if (!Array.isArray(json.choices) || json.choices.length === 0) return { outcome: Outcome.BAD_BODY, json };
    return { outcome: Outcome.OK, json };
  }
  if (isContextError(status, text)) return { outcome: Outcome.CONTEXT_EXCEEDED, json: null };
  if (isRetryableStatus(status)) return { outcome: Outcome.RETRYABLE_STATUS, json: null };
  return { outcome: Outcome.FATAL_STATUS, json: null };
}

// ── 가중 선택 (SPEC.md 2절 pickWeighted, 3.2) ─────────

export function pickWeighted(candidates, rng) {
  const total = candidates.reduce((s, d) => s + d.rpm, 0);
  const r = rng() * total;
  let acc = 0;
  for (const d of candidates) {
    acc += d.rpm;
    if (acc > r) return d;
  }
  return candidates[candidates.length - 1];
}

// ── transport (SPEC.md 1절, 3.6) ─────────────────────
// transport({ url, headers, body, signal }) → Promise<{ status, text }>
// 연결 실패 등은 예외로 던진다. 타임아웃은 라우터가 signal + 타이머로 강제한다.
// 한 번 호출 = 정확히 한 번의 HTTP 요청: 스스로 재시도하지 않고 리다이렉트를 따라가지 않는다.
// Node fetch(undici)는 POST 를 재시도하지 않고, 자체 타임아웃은 라우터 timeoutSeconds 보다 길다(헤더 300초).

export function fetchTransport(fetchImpl = globalThis.fetch) {
  return async ({ url, headers, body, signal }) => {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text };
  };
}

// ── 라우터 ───────────────────────────────────────────

export class Router {
  #cfg;
  #keys;
  #transport;
  #rng;
  #now;
  #state = new Map(); // deploymentId → { failures: number[], cooldownUntil: number|null }

  // config: models.json 형식 객체. 생성자에서 normalizeConfig 를 부른다(= parseConfig 결과를 넘기는 것과 같다).
  // now 기본값 Date.now: Node 에는 절전 포함 단조 시계가 없어 벽시계를 쓴다 (SPEC.md 1.2).
  constructor({ config, keys = {}, transport = fetchTransport(), rng = Math.random, now = Date.now }) {
    this.#cfg = normalizeConfig(config);
    this.#keys = { ...keys };
    this.#transport = transport;
    this.#rng = rng;
    this.#now = now;
  }

  get settings() {
    return this.#cfg.settings;
  }

  #st(id) {
    let s = this.#state.get(id);
    if (!s) {
      s = { failures: [], cooldownUntil: null };
      this.#state.set(id, s);
    }
    return s;
  }

  #isCoolingDown(id, now) {
    const s = this.#st(id);
    return s.cooldownUntil !== null && now < s.cooldownUntil;
  }

  #recordFailure(id, now) {
    const s = this.#st(id);
    const windowMs = this.#cfg.settings.cooldownMs;
    // 쿨다운 중인 배포의 실패(동시 요청이 늦게 끝난 것)도 그대로 기록한다. 다시 allowedFails 에 닿으면 연장된다 (SPEC.md 3.4).
    s.failures = s.failures.filter((t) => now - t < windowMs);
    s.failures.push(now);
    if (s.failures.length >= this.#cfg.settings.allowedFails) {
      s.cooldownUntil = now + windowMs;
      s.failures = [];
    }
  }

  #key(providerId) {
    const k = this.#keys[providerId];
    return typeof k === 'string' && k.length > 0 ? k : null;
  }

  // 후보 목록 (설정 순서 유지)과, 토큰 한도 때문에만 빠진 배포가 있었는지.
  #candidates(group, tokens, attempted, now) {
    const out = [];
    let tokenExcluded = false;
    for (const d of this.#cfg.groups[group]) {
      if (!d.enabled) continue;
      if (this.#key(d.provider) === null) continue;
      if (this.#isCoolingDown(d.id, now)) continue;
      if (attempted.has(d.id)) continue;
      if (d.maxInputTokens !== null && tokens > d.maxInputTokens) {
        tokenExcluded = true;
        continue;
      }
      out.push(d);
    }
    return { candidates: out, tokenExcluded };
  }

  // 호출자 취소는 RouterError 로 감싸지 않고 signal.reason(기본 AbortError)을 그대로 던진다 (SPEC.md 1.1).
  async #send(d, request, signal) {
    const p = this.#cfg.providers.get(d.provider);
    const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.#key(d.provider)}`,
      ...p.extraHeaders,
    };
    const body = JSON.stringify({ ...request, model: d.model });
    const ctrl = new AbortController();
    let timedOut = false;
    let timer;
    let onCancel;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        reject(new Error('timeout'));
      }, this.#cfg.settings.timeoutMs);
      onCancel = () => {
        ctrl.abort();
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onCancel, { once: true });
    });
    try {
      const res = await Promise.race([this.#transport({ url, headers, body, signal: ctrl.signal }), guard]);
      signal?.throwIfAborted();
      return { status: res.status, text: res.text };
    } catch (e) {
      // 호출자 취소가 원인이면 network_error 가 아니다. 취소를 그대로 전파한다.
      signal?.throwIfAborted();
      return { error: timedOut ? Outcome.TIMEOUT : Outcome.NETWORK_ERROR, message: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
  }

  async #runGroup(group, request, tokens, attempted, attempts, signal) {
    const maxAttempts = 1 + this.#cfg.settings.numRetries;
    let n = 0;
    let last = null; // 'context' | 'retryable'
    let tokenExcludedAtStart = false;
    while (n < maxAttempts) {
      signal?.throwIfAborted(); // 취소 확인: 매 시도 직전(후보 계산·rng 전)
      const { candidates, tokenExcluded } = this.#candidates(group, tokens, attempted, this.#now());
      if (candidates.length === 0) {
        if (n === 0) tokenExcludedAtStart = tokenExcluded;
        break;
      }
      const d = pickWeighted(candidates, this.#rng);
      attempted.add(d.id);
      n++;
      const started = performance.now(); // durationMs 는 실제 경과 시간 (주입된 now 와 무관)
      const r = await this.#send(d, request, signal);
      const rec = { deploymentId: d.id, group, outcome: null, status: null, durationMs: 0, message: null };
      let json = null;
      if (r.error) {
        rec.outcome = r.error;
        rec.message = r.message;
      } else {
        const c = classifyResponse(r.status, r.text);
        rec.outcome = c.outcome;
        rec.status = r.status;
        json = c.json;
      }
      rec.durationMs = Math.round(performance.now() - started);
      attempts.push(rec);

      switch (rec.outcome) {
        case Outcome.OK:
          return { ok: true, result: { response: json, deploymentId: d.id, group, attempts } };
        case Outcome.FATAL_STATUS:
          throw new RouterError(ErrorKind.NON_RETRYABLE, `${d.id} returned ${r.status}`, {
            status: r.status,
            body: r.text,
            attempts,
          });
        case Outcome.CONTEXT_EXCEEDED:
          last = 'context';
          break;
        default: // retryable_status, bad_body, timeout, network_error
          this.#recordFailure(d.id, this.#now());
          last = 'retryable';
      }
    }
    const reason = n > 0 ? last : tokenExcludedAtStart ? 'context' : 'retryable';
    return { ok: false, reason };
  }

  // options.signal: AbortSignal (선택). 취소되면 signal.reason 을 던진다 (SPEC.md 1.1).
  async route(group, request, { signal } = {}) {
    const attempts = [];
    if (typeof group !== 'string' || !(group in this.#cfg.groups)) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, `unknown group: ${group}`, { attempts });
    }
    if (!request || typeof request !== 'object' || Array.isArray(request) || !Array.isArray(request.messages)) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, 'request.messages must be an array', { attempts });
    }
    if (request.stream === true) {
      throw new RouterError(ErrorKind.INVALID_REQUEST, 'stream is not supported', { attempts });
    }
    const tokens = estimateTokens(request);
    const attempted = new Set();
    const visited = new Set();
    const queue = [group];
    const reasons = [];
    const { fallbacks, contextWindowFallbacks } = this.#cfg.settings;
    while (queue.length > 0) {
      const g = queue.shift();
      visited.add(g);
      const r = await this.#runGroup(g, request, tokens, attempted, attempts, signal);
      if (r.ok) return r.result;
      reasons.push(r.reason);
      const next = (r.reason === 'context' ? contextWindowFallbacks[g] : fallbacks[g]) ?? [];
      for (const n of next) if (!visited.has(n) && !queue.includes(n)) queue.push(n);
    }
    const kind = reasons.every((x) => x === 'context') ? ErrorKind.CONTEXT_WINDOW_EXCEEDED : ErrorKind.ALL_FAILED;
    throw new RouterError(kind, `all deployments failed (groups: ${[...visited].join(' → ')})`, { attempts });
  }

  // 오프라인 뒤 회복용: 모든 배포의 실패 기록·쿨다운을 비운다 (SPEC.md 1.4)
  resetState() {
    this.#state.clear();
  }

  // 테스트·디버깅용 상태 조회 (SPEC.md 1절). 설정의 모든 배포(비활성·키 없음 포함)
  deploymentStates() {
    const now = this.#now();
    const windowMs = this.#cfg.settings.cooldownMs;
    const out = {};
    for (const list of Object.values(this.#cfg.groups)) {
      for (const d of list) {
        const s = this.#st(d.id);
        const cooling = this.#isCoolingDown(d.id, now);
        out[d.id] = {
          coolingDown: cooling,
          cooldownUntilMs: cooling ? s.cooldownUntil : null,
          recentFailures: s.failures.filter((t) => now - t < windowMs).length,
        };
      }
    }
    return out;
  }
}
