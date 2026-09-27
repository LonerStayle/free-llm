import { globalFetch } from './runtime.js';
import type { FetchInit, FetchLike, FetchResponseLike } from './runtime.js';
import type { Transport } from './types.js';

/**
 * 기본 transport: 전역 fetch (SPEC 3.6).
 * - 한 번 호출 = HTTP 요청 한 번. 재시도·자체 타임아웃 없음(시간 초과는 라우터 타이머가 signal 로 끊는다).
 * - `redirect: 'manual'` 을 넘긴다. Node(undici) 는 3xx 를 그대로 돌려주지만,
 *   RN 기기 런타임의 fetch 는 이 옵션을 무시하고 리다이렉트를 따라간다(SPEC 3.6 의 RN 예외).
 */
export function fetchTransport<Init = FetchInit>(fetchImpl?: (url: string, init: Init) => Promise<FetchResponseLike>): Transport {
  return async ({ url, headers, body, signal }) => {
    // Init 은 DOM·RN·Node 의 RequestInit 등 무엇이든 된다. 넘기는 값은 FetchInit 모양이다.
    const f = (fetchImpl as FetchLike | undefined) ?? globalFetch();
    const res = await f(url, { method: 'POST', headers, body, signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text };
  };
}
