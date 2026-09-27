#!/usr/bin/env node
// 모의 LLM 제공처 (Node ESM, 의존성 없음). 사용법은 README.md.
//
//   node server.mjs [--port 0] [--host 127.0.0.1] [--exit-on-stdin-close]
//   → stdout 첫 줄: {"port":12345,"url":"http://127.0.0.1:12345"}
//
// 다른 스크립트에서 import 하면 서버를 띄우지 않고 ScriptBook / defaultCompletion 만 쓴다.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export function defaultCompletion(model, seq = 0) {
  return {
    id: `mock-${seq}`,
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `ok:${model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

// 응답 스크립트 한 항목을 실제 응답으로 바꾼다.
//   { status?=200, body?, headers?, delayMs?=0, bodyDelayMs?=0, action?: "close" }
// body 가 문자열이면 그대로, 객체면 JSON. 생략하면 2xx → 정상 완성, 그 외 → {"error":{...}}.
export function materialize(entry, model, seq) {
  const status = entry.status ?? 200;
  let text;
  if (entry.body === undefined) {
    text = JSON.stringify(
      status >= 200 && status <= 299
        ? defaultCompletion(model, seq)
        : { error: { message: `mock status ${status}`, code: status } },
    );
  } else if (typeof entry.body === 'string') {
    text = entry.body;
  } else {
    text = JSON.stringify(entry.body);
  }
  return {
    status,
    text,
    headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    delayMs: entry.delayMs ?? 0,
    bodyDelayMs: entry.bodyDelayMs ?? 0,
    action: entry.action ?? null,
  };
}

// /__scenario 의 responses 검사. 잘못되면 이유 문자열, 괜찮으면 null.
export function validateResponses(responses) {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) return 'responses must be an object';
  for (const [model, list] of Object.entries(responses)) {
    if (!Array.isArray(list)) return `responses.${model} must be an array`;
    for (const [i, e] of list.entries()) {
      const at = `responses.${model}[${i}]`;
      if (e === null || typeof e !== 'object' || Array.isArray(e)) return `${at} must be an object`;
      if (e.status !== undefined && !(Number.isInteger(e.status) && e.status >= 200 && e.status <= 599)) {
        return `${at}.status must be an integer 200..599`;
      }
      if (e.body !== undefined && (e.body === null || (typeof e.body !== 'string' && typeof e.body !== 'object'))) {
        return `${at}.body must be a string or JSON object/array`;
      }
      for (const k of ['delayMs', 'bodyDelayMs']) {
        if (e[k] !== undefined && !(Number.isFinite(e[k]) && e[k] >= 0)) return `${at}.${k} must be a number >= 0`;
      }
      if (e.action !== undefined && e.action !== 'close') return `${at}.action must be "close"`;
      if (e.headers !== undefined) {
        if (e.headers === null || typeof e.headers !== 'object' || Array.isArray(e.headers)) return `${at}.headers must be an object`;
        for (const [k, v] of Object.entries(e.headers)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) return `${at}.headers: invalid name ${JSON.stringify(k)}`;
          if (typeof v !== 'string' || /[\r\n\0]/.test(v)) return `${at}.headers.${k} must be a string without CR/LF`;
        }
      }
    }
  }
  return null;
}

// model 이름별 응답 스크립트. 순서대로 소비하고, 다 쓰면 기본 200 정상 응답.
export class ScriptBook {
  constructor(responses = {}) {
    this.responses = responses;
    this.used = {};
    this.seq = 0;
  }
  next(model) {
    const list = this.responses[model] ?? [];
    const i = this.used[model] ?? 0;
    this.used[model] = i + 1;
    this.seq++;
    return materialize(i < list.length ? list[i] : {}, model, this.seq);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockServer() {
  let book = new ScriptBook();
  let log = [];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return;
    }

    if (req.method === 'POST' && path === '/__scenario') {
      let spec;
      try {
        spec = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: { message: 'scenario must be JSON' } });
      }
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        return sendJson(res, 400, { error: { message: 'scenario must be a JSON object' } });
      }
      const responses = spec.responses ?? {};
      const problem = validateResponses(responses);
      if (problem) return sendJson(res, 400, { error: { message: problem } });
      book = new ScriptBook(responses);
      log = [];
      return sendJson(res, 200, { ok: true, models: Object.keys(book.responses) });
    }
    if (req.method === 'GET' && path === '/__log') {
      return sendJson(res, 200, { requests: log });
    }
    if (req.method === 'POST' && path === '/__reset') {
      book = new ScriptBook();
      log = [];
      return sendJson(res, 200, { ok: true });
    }

    const m = path.match(/^\/([^/]+)\/chat\/completions$/);
    if (req.method !== 'POST' || !m) {
      return sendJson(res, 404, { error: { message: `mock: unknown route ${req.method} ${path}` } });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    log.push({ method: req.method, path, headers: { ...req.headers }, body });

    const model = body && typeof body === 'object' ? body.model : undefined;
    const r = book.next(String(model));
    const gone = () => res.destroyed || req.socket.destroyed; // 클라이언트가 이미 끊음 (타임아웃·취소)

    if (r.delayMs > 0) await sleep(r.delayMs);
    if (gone()) return;
    if (r.action === 'close') {
      req.socket.destroy();
      return;
    }
    const bytes = Buffer.from(r.text, 'utf8');
    res.writeHead(r.status, { ...r.headers, 'content-length': bytes.length });
    if (r.bodyDelayMs > 0) {
      // 헤더와 본문 앞 절반을 먼저 보내고, 나머지는 bodyDelayMs 뒤에 보낸다.
      const half = Math.floor(bytes.length / 2);
      res.write(bytes.subarray(0, half));
      await sleep(r.bodyDelayMs);
      if (gone()) return;
      res.end(bytes.subarray(half));
    } else {
      res.end(bytes);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      // 어떤 입력에도 프로세스가 죽지 않게: 500 으로 응답하고 stderr 에 남긴다.
      process.stderr.write(`mock-server: ${e?.stack ?? e}\n`);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: { message: `mock internal error: ${e?.message ?? e}` } });
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  });
  // Node 기본 keep-alive 5초는 다른 플랫폼 클라이언트의 연결 풀 유휴 시간(Dart 15초, OkHttp 5분)보다 짧아
  // 막 닫힌 연결을 재사용하는 경합이 생긴다. 충분히 길게 둔다 (headersTimeout 은 그보다 길게).
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  return server;
}

function parseArgs(argv) {
  const out = { port: 0, host: '127.0.0.1', exitOnStdinClose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--exit-on-stdin-close') out.exitOnStdinClose = true;
  }
  return out;
}

// 클라이언트가 쓸 URL. 와일드카드 바인딩이면 127.0.0.1 로 출력한다.
function clientUrl(host, port) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return `http://127.0.0.1:${port}`;
  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  const { port, host, exitOnStdinClose } = parseArgs(process.argv.slice(2));
  const server = createMockServer();
  server.listen(port, host, () => {
    const actual = server.address().port;
    process.stdout.write(JSON.stringify({ port: actual, url: clientUrl(host, actual) }) + '\n');
  });
  const stop = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (exitOnStdinClose) {
    // 부모 테스트 프로세스가 죽으면 stdin 파이프가 닫힌다 → 같이 종료 (고아 방지).
    process.stdin.on('end', stop);
    process.stdin.on('close', stop);
    process.stdin.resume();
  }
}
