import { JEV_MODEL } from './jev/client.js';

export type Env = Record<string, string | undefined>;

export interface JevEnvConfig {
  apiKey: string;
  timeoutMs: number;
  zeroDataRetention: boolean;
}

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

/** Jev is reached only through Vercel AI Gateway, never the TypeSafe API or a proxy. */
function jevConfig(env: Env): JevEnvConfig {
  const model = text(env, 'JEV_MODEL');
  if (model && model !== JEV_MODEL) throw new Error(`JEV_MODEL must be ${JEV_MODEL} via Vercel AI Gateway`);
  const apiKey = text(env, 'AI_GATEWAY_API_KEY');
  if (!apiKey) throw new Error('Set AI_GATEWAY_API_KEY for Jev via Vercel AI Gateway');
  return {
    apiKey,
    timeoutMs: integer(env, 'JEV_TIMEOUT_MS', 15_000, 1_000, 120_000),
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
