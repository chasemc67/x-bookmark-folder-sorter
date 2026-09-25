import type { JevEnvConfig } from './jev/client.js';
import type { JevProvider } from './jev/types.js';

export type Env = Record<string, string | undefined>;

export interface XEnvConfig {
  userId?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  store?: { url: string; token: string; key: string };
}

export interface SorterConfig {
  dryRun: boolean;
  minConfidence: number;
  misfiledMinConfidence: number;
  checkMisfiled: boolean;
  refileMisfiled: boolean;
  maxBookmarksPerRun: number;
  maxWritesPerRun: number;
  jevBatchSize: number;
  maxTextChars: number;
  folderDescriptions: Record<string, string>;
  excludedFolders: string[];
  jev: JevEnvConfig;
  x: XEnvConfig;
}

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Live mode requires an explicit false; unset, empty, or typos stay in dry-run. */
export function parseDryRun(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0' || normalized === 'no');
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = text(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (['true', '1', 'yes'].includes(value)) return true;
  if (['false', '0', 'no'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function number(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = number(env, name, fallback, min, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function folderDescriptions(env: Env): Record<string, string> {
  const raw = text(env, 'FOLDER_DESCRIPTIONS');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FOLDER_DESCRIPTIONS must be a JSON object of folder name -> description');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('FOLDER_DESCRIPTIONS must be a JSON object of folder name -> description');
  }
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function jevConfig(env: Env): JevEnvConfig {
  const explicit = text(env, 'JEV_PROVIDER')?.toLowerCase();
  if (explicit && !['jev', 'typesafe', 'gateway'].includes(explicit)) {
    throw new Error('JEV_PROVIDER must be jev, typesafe, or gateway');
  }
  const provider: JevProvider | undefined = (explicit as JevProvider | undefined)
    ?? (text(env, 'JEV_API_KEY') ? 'jev'
      : text(env, 'TYPESAFE_API_KEY') ? 'typesafe'
        : text(env, 'AI_GATEWAY_API_KEY') || text(env, 'VERCEL_OIDC_TOKEN') ? 'gateway'
          : undefined);
  if (!provider) {
    throw new Error('Set JEV_API_KEY (jevtypesafeai.com), TYPESAFE_API_KEY, or AI_GATEWAY_API_KEY / Vercel OIDC for Jev');
  }
  const apiKey = provider === 'jev' ? text(env, 'JEV_API_KEY')
    : provider === 'typesafe' ? text(env, 'TYPESAFE_API_KEY')
      : text(env, 'AI_GATEWAY_API_KEY');
  if (provider !== 'gateway' && !apiKey) {
    throw new Error(`${provider === 'jev' ? 'JEV_API_KEY' : 'TYPESAFE_API_KEY'} is required for JEV_PROVIDER=${provider}`);
  }
  return {
    provider,
    apiKey,
    url: text(env, 'JEV_API_URL'),
    model: text(env, 'JEV_MODEL'),
    timeoutMs: integer(env, 'JEV_TIMEOUT_MS', 20_000, 1_000, 120_000),
    zeroDataRetention: bool(env, 'GATEWAY_ZERO_DATA_RETENTION', false),
  };
}

function xConfig(env: Env): XEnvConfig {
  const url = text(env, 'KV_REST_API_URL') ?? text(env, 'UPSTASH_REDIS_REST_URL');
  const token = text(env, 'KV_REST_API_TOKEN') ?? text(env, 'UPSTASH_REDIS_REST_TOKEN');
  return {
    userId: text(env, 'X_USER_ID'),
    accessToken: text(env, 'X_ACCESS_TOKEN'),
    clientId: text(env, 'X_CLIENT_ID'),
    clientSecret: text(env, 'X_CLIENT_SECRET'),
    refreshToken: text(env, 'X_REFRESH_TOKEN'),
    store: url && token ? { url, token, key: text(env, 'X_TOKEN_STORE_KEY') ?? 'x-bookmark-folder-sorter:x-oauth' } : undefined,
  };
}

export function loadConfig(env: Env = process.env): SorterConfig {
  return {
    dryRun: parseDryRun(env.DRY_RUN),
    minConfidence: number(env, 'MIN_CONFIDENCE', 0.7, 0, 1),
    misfiledMinConfidence: number(env, 'MISFILED_MIN_CONFIDENCE', 0.9, 0, 1),
    checkMisfiled: bool(env, 'CHECK_MISFILED', true),
    refileMisfiled: bool(env, 'REFILE_MISFILED', false),
    maxBookmarksPerRun: integer(env, 'MAX_BOOKMARKS_PER_RUN', 200, 1, 800),
    maxWritesPerRun: integer(env, 'MAX_WRITES_PER_RUN', 50, 0, 800),
    jevBatchSize: integer(env, 'JEV_BATCH_SIZE', 10, 1, 50),
    maxTextChars: integer(env, 'MAX_TEXT_CHARS', 400, 40, 4000),
    folderDescriptions: folderDescriptions(env),
    excludedFolders: (text(env, 'EXCLUDED_FOLDERS') ?? '').split(',').map(name => name.trim()).filter(Boolean),
    jev: jevConfig(env),
    x: xConfig(env),
  };
}
