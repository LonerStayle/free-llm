// 설정 파싱 (SPEC 6절). 모르는 키는 모든 레벨에서 무시하고, 선택 필드의 null 은 없는 것으로 본다.
// 그룹·폴백 표는 Map 으로 둔다: 일반 객체에 넣으면 "constructor"·"__proto__" 같은 그룹 이름이 프로토타입과 섞인다.
import { ConfigError } from './errors.js';

export interface ProviderConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly keyName: string | null;
  readonly extraHeaders: Readonly<Record<string, string>>;
}

export interface DeploymentConfig {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly rpm: number;
  readonly maxInputTokens: number | null;
  readonly enabled: boolean;
}

export interface Settings {
  readonly numRetries: number;
  readonly allowedFails: number;
  readonly cooldownSeconds: number;
  readonly timeoutSeconds: number;
  readonly fallbacks: ReadonlyMap<string, readonly string[]>;
  readonly contextWindowFallbacks: ReadonlyMap<string, readonly string[]>;
  /** round(cooldownSeconds × 1000) */
  readonly cooldownMs: number;
  /** round(timeoutSeconds × 1000) */
  readonly timeoutMs: number;
}

/** parseConfig / normalizeConfig 결과. 설정 순서를 유지한다. */
export interface Config {
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  readonly groups: ReadonlyMap<string, readonly DeploymentConfig[]>;
  readonly settings: Settings;
}

const INT_MAX = 2147483647;
const normalized = new WeakSet<object>();

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
// 정수 = 소수부가 0 인 JSON 수 (4, 4.0 모두 4). JSON.parse 는 4.0 을 4 로 읽는다.
const isInt = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= INT_MAX;
const nonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isHeaderReserved = (name: string) => /^(authorization|content-type)$/i.test(name);

/** models.json 형식 문자열 → Config. 잘못되면 ConfigError. */
export function parseConfig(json: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ConfigError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return normalizeConfig(raw);
}

export function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && normalized.has(value);
}

/** 이미 파싱한 JSON 값(객체) → Config. parseConfig 결과를 넣으면 그대로 돌려준다. */
export function normalizeConfig(raw: unknown): Config {
  if (isConfig(raw)) return raw;
  if (!isObj(raw)) throw new ConfigError('config must be an object');
  const version = own(raw, 'version');
  if (version != null && version !== 1) throw new ConfigError(`unsupported version: ${String(version)}`);

  const rawProviders = own(raw, 'providers');
  if (!Array.isArray(rawProviders)) throw new ConfigError('providers must be an array');
  const providers = new Map<string, ProviderConfig>();
  for (const p of rawProviders) {
    if (!isObj(p)) throw new ConfigError('provider must be an object');
    const id = own(p, 'id');
    if (!nonEmptyStr(id)) throw new ConfigError('provider.id must be a non-empty string');
    if (providers.has(id)) throw new ConfigError(`duplicate provider id: ${id}`);
    const baseUrl = own(p, 'baseUrl');
    if (!nonEmptyStr(baseUrl)) throw new ConfigError(`provider ${id}: baseUrl must be a non-empty string`);
    const keyName = own(p, 'keyName');
    if (keyName != null && typeof keyName !== 'string') throw new ConfigError(`provider ${id}: keyName must be a string`);
    const extra = own(p, 'extraHeaders') ?? {};
    if (!isObj(extra)) throw new ConfigError(`provider ${id}: extraHeaders must be an object`);
    const headers: [string, string][] = [];
    for (const [name, value] of Object.entries(extra)) {
      if (isHeaderReserved(name)) throw new ConfigError(`provider ${id}: extraHeaders must not set ${name}`);
      if (typeof value !== 'string') throw new ConfigError(`provider ${id}: extraHeaders.${name} must be a string`);
      headers.push([name, value]);
    }
    providers.set(id, {
      id,
      baseUrl,
      keyName: keyName ?? null,
      extraHeaders: Object.freeze(Object.fromEntries(headers)),
    });
  }

  const rawGroups = own(raw, 'groups');
  if (!isObj(rawGroups)) throw new ConfigError('groups must be an object');
  const groups = new Map<string, readonly DeploymentConfig[]>();
  const seen = new Set<string>();
  for (const [name, g] of Object.entries(rawGroups)) {
    const deployments = isObj(g) ? own(g, 'deployments') : undefined;
    if (!Array.isArray(deployments)) throw new ConfigError(`group ${name}: deployments must be an array`);
    const list: DeploymentConfig[] = [];
    for (const d of deployments) {
      if (!isObj(d)) throw new ConfigError(`group ${name}: deployment must be an object`);
      const id = own(d, 'id');
      if (!nonEmptyStr(id)) throw new ConfigError(`group ${name}: deployment.id must be a non-empty string`);
      if (seen.has(id)) throw new ConfigError(`duplicate deployment id: ${id}`);
      seen.add(id);
      const provider = own(d, 'provider');
      if (typeof provider !== 'string' || !providers.has(provider)) {
        throw new ConfigError(`deployment ${id}: unknown provider ${String(provider)}`);
      }
      const model = own(d, 'model');
      if (!nonEmptyStr(model)) throw new ConfigError(`deployment ${id}: model must be a non-empty string`);
      const rpm = own(d, 'rpm');
      if (!isInt(rpm, 1)) throw new ConfigError(`deployment ${id}: rpm must be an integer in [1, ${INT_MAX}]`);
      const maxInputTokens = own(d, 'maxInputTokens');
      if (maxInputTokens != null && !isInt(maxInputTokens, 1)) {
        throw new ConfigError(`deployment ${id}: maxInputTokens must be an integer in [1, ${INT_MAX}]`);
      }
      const enabled = own(d, 'enabled');
      if (enabled != null && typeof enabled !== 'boolean') throw new ConfigError(`deployment ${id}: enabled must be a boolean`);
      list.push(
        Object.freeze({
          id,
          provider,
          model,
          rpm,
          maxInputTokens: (maxInputTokens as number | null | undefined) ?? null,
          enabled: enabled ?? true,
        }),
      );
    }
    groups.set(name, Object.freeze(list));
  }

  const rs = own(raw, 'settings') ?? {};
  if (!isObj(rs)) throw new ConfigError('settings must be an object');
  const pick = <T>(k: string, dflt: T): unknown => own(rs, k) ?? dflt;
  const numRetries = pick('numRetries', 3);
  if (!isInt(numRetries, 0)) throw new ConfigError('settings.numRetries must be an integer >= 0');
  const allowedFails = pick('allowedFails', 3);
  if (!isInt(allowedFails, 1)) throw new ConfigError('settings.allowedFails must be an integer >= 1');
  const cooldownSeconds = pick('cooldownSeconds', 60);
  const timeoutSeconds = pick('timeoutSeconds', 60);
  for (const [k, v] of [
    ['cooldownSeconds', cooldownSeconds],
    ['timeoutSeconds', timeoutSeconds],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) throw new ConfigError(`settings.${k} must be a number > 0`);
  }
  const fallbackTable = (k: string): ReadonlyMap<string, readonly string[]> => {
    const t = pick(k, {});
    if (!isObj(t)) throw new ConfigError(`settings.${k} must be an object`);
    const out = new Map<string, readonly string[]>();
    for (const [from, list] of Object.entries(t)) {
      if (!groups.has(from)) throw new ConfigError(`settings.${k}: unknown group ${from}`);
      if (!Array.isArray(list)) throw new ConfigError(`settings.${k}.${from} must be an array`);
      for (const to of list) {
        if (typeof to !== 'string' || !groups.has(to)) throw new ConfigError(`settings.${k}.${from}: unknown group ${String(to)}`);
      }
      out.set(from, Object.freeze([...(list as string[])]));
    }
    return out;
  };
  const cd = cooldownSeconds as number;
  const to = timeoutSeconds as number;
  const settings: Settings = Object.freeze({
    numRetries,
    allowedFails,
    cooldownSeconds: cd,
    timeoutSeconds: to,
    fallbacks: fallbackTable('fallbacks'),
    contextWindowFallbacks: fallbackTable('contextWindowFallbacks'),
    // 초 → 밀리초: 가장 가까운 정수 (양수라 .5 는 올림)
    cooldownMs: Math.round(cd * 1000),
    timeoutMs: Math.round(to * 1000),
  });

  const config: Config = Object.freeze({ providers, groups, settings });
  normalized.add(config);
  return config;
}
