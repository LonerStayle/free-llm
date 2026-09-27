import { Outcome } from './types.js';
import type { JsonObject } from './types.js';

export const CONTEXT_PATTERNS: readonly string[] = ['context length', 'context_length', 'maximum context', 'too many tokens'];

/**
 * 토큰 추정 (SPEC 3.1): ceil(units / 4). units = messages[*].content 의 UTF-16 길이 합.
 * JS string.length 가 UTF-16 코드 유닛 수라 그대로 쓴다.
 */
export function estimateTokens(request: { messages: readonly unknown[] }): number {
  let units = 0;
  for (const m of request.messages) {
    const content = m !== null && typeof m === 'object' ? (m as { content?: unknown }).content : undefined;
    if (typeof content === 'string') units += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const text = part !== null && typeof part === 'object' ? (part as { text?: unknown }).text : undefined;
        if (typeof text === 'string') units += text.length;
      }
    }
  }
  return Math.floor((units + 3) / 4);
}

/** ASCII A–Z 만 a–z 로. 로캘·유니코드 소문자화는 쓰지 않는다 (SPEC 4절). */
export function asciiLower(text: string): string {
  // i 플래그 없는 [A-Z] 는 ASCII 대문자에만 맞는다.
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isRetryableStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isContextError(status: number, text: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const lower = asciiLower(text);
  return CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

export type ResponseOutcome = 'ok' | 'bad_body' | 'context_exceeded' | 'retryable_status' | 'fatal_status';

/** HTTP 응답 → Outcome (SPEC 4절, 위에서부터 처음 맞는 것). ok 이면 json 이 있다. */
export function classifyResponse(status: number, text: string): { outcome: ResponseOutcome; json: JsonObject | null } {
  if (status >= 200 && status <= 299) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { outcome: Outcome.BAD_BODY, json: null };
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return { outcome: Outcome.BAD_BODY, json: null };
    const obj = json as JsonObject;
    if (obj['error'] != null) return { outcome: Outcome.BAD_BODY, json: null };
    const choices = obj['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return { outcome: Outcome.BAD_BODY, json: null };
    return { outcome: Outcome.OK, json: obj };
  }
  if (isContextError(status, text)) return { outcome: Outcome.CONTEXT_EXCEEDED, json: null };
  if (isRetryableStatus(status)) return { outcome: Outcome.RETRYABLE_STATUS, json: null };
  return { outcome: Outcome.FATAL_STATUS, json: null };
}

/** rpm 가중 무작위 선택 (SPEC 2절 pickWeighted). rng 를 정확히 한 번 부른다. cands 는 비어 있지 않아야 한다. */
export function pickWeighted<T extends { readonly rpm: number }>(cands: readonly T[], rng: () => number): T {
  let total = 0;
  for (const d of cands) total += d.rpm;
  const r = rng() * total;
  let acc = 0;
  for (const d of cands) {
    acc += d.rpm;
    if (acc > r) return d;
  }
  return cands[cands.length - 1]!; // 부동소수 방어
}
