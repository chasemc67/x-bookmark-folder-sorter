import { sorterSettings, type SorterSettings } from '../config/sorter.js';

export type Env = Record<string, string | undefined>;

/**
 * The only values read from env: real credentials. Everything else is in config/sorter.ts.
 * X OAuth needs no env var: Vercel Connect holds the client credentials and the user grant,
 * and the SDK authenticates with the Vercel OIDC token (injected on Vercel, `vercel env pull` locally).
 */
export interface Secrets {
  aiGatewayApiKey: string;
}

export type SorterConfig = SorterSettings & { secrets: Secrets };

const MOVED_TO_CONFIG = 'now set in config/sorter.ts';
const HELD_BY_CONNECT = 'X OAuth now lives in the Vercel Connect connector';
const KV_REMOVED = 'KV only held X tokens, which Vercel Connect now manages; disconnect the Upstash/KV integration from this project';

/**
 * Env vars this app used to read. Setting one now fails the run instead of being silently ignored,
 * so a stale Vercel env var (e.g. DRY_RUN=true while config says live) can never change behavior unnoticed.
 */
export const RETIRED_ENV_VARS: Readonly<Record<string, string>> = {
  DRY_RUN: MOVED_TO_CONFIG,
  JEV_MODEL: MOVED_TO_CONFIG,
  JEV_TIMEOUT_MS: MOVED_TO_CONFIG,
  GATEWAY_ZERO_DATA_RETENTION: MOVED_TO_CONFIG,
  MIN_CONFIDENCE: MOVED_TO_CONFIG,
  MISFILED_MIN_CONFIDENCE: MOVED_TO_CONFIG,
  CHECK_MISFILED: MOVED_TO_CONFIG,
  REFILE_MISFILED: MOVED_TO_CONFIG,
  MAX_BOOKMARKS_PER_RUN: MOVED_TO_CONFIG,
  MAX_WRITES_PER_RUN: MOVED_TO_CONFIG,
  JEV_BATCH_SIZE: MOVED_TO_CONFIG,
  MAX_TEXT_CHARS: MOVED_TO_CONFIG,
  FOLDER_DESCRIPTIONS: MOVED_TO_CONFIG,
  EXCLUDED_FOLDERS: MOVED_TO_CONFIG,
  X_USER_ID: MOVED_TO_CONFIG,
  X_CLIENT_ID: HELD_BY_CONNECT,
  X_CLIENT_SECRET: HELD_BY_CONNECT,
  X_REFRESH_TOKEN: HELD_BY_CONNECT,
  X_ACCESS_TOKEN: HELD_BY_CONNECT,
  X_TOKEN_STORE_KEY: HELD_BY_CONNECT,
  X_REDIRECT_URI: HELD_BY_CONNECT,
  KV_URL: KV_REMOVED,
  KV_REST_API_URL: KV_REMOVED,
  KV_REST_API_TOKEN: KV_REMOVED,
  KV_REST_API_READ_ONLY_TOKEN: KV_REMOVED,
  UPSTASH_REDIS_REST_URL: KV_REMOVED,
  UPSTASH_REDIS_REST_TOKEN: KV_REMOVED,
  JEV_API_KEY: 'Jev runs only through Vercel AI Gateway (AI_GATEWAY_API_KEY)',
  TYPESAFE_API_KEY: 'Jev runs only through Vercel AI Gateway (AI_GATEWAY_API_KEY)',
  JEV_PROVIDER: 'Jev runs only through Vercel AI Gateway (AI_GATEWAY_API_KEY)',
};

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function assertNoRetiredEnv(env: Env): void {
  const present = Object.keys(RETIRED_ENV_VARS).filter(name => env[name] !== undefined);
  if (present.length > 0) {
    const details = present.map(name => `${name} (${RETIRED_ENV_VARS[name]})`).join('; ');
    throw new Error(`Remove retired env vars from Vercel and .env/.env.local: ${details}`);
  }
}

function inRange(name: string, value: number, min: number, max: number, integer = false): void {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`config/sorter.ts: ${name} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  }
}

export function validateSettings(settings: SorterSettings): SorterSettings {
  inRange('minConfidence', settings.minConfidence, 0, 1);
  inRange('misfiledMinConfidence', settings.misfiledMinConfidence, 0, 1);
  inRange('maxBookmarksPerRun', settings.maxBookmarksPerRun, 1, 800, true);
  inRange('maxWritesPerRun', settings.maxWritesPerRun, 0, 800, true);
  inRange('jevBatchSize', settings.jevBatchSize, 1, 50, true);
  inRange('maxTextChars', settings.maxTextChars, 40, 4000, true);
  inRange('jevTimeoutMs', settings.jevTimeoutMs, 1_000, 120_000, true);
  if (settings.xUserId && !/^[0-9]{1,19}$/.test(settings.xUserId)) {
    throw new Error('config/sorter.ts: xUserId must be a numeric X user id or empty');
  }
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(settings.xConnectConnector)) {
    throw new Error('config/sorter.ts: xConnectConnector must be a Vercel Connect connector uid such as oauth/x-bookmarks');
  }
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(settings.xConnectSubjectId)) {
    throw new Error('config/sorter.ts: xConnectSubjectId must be a non-empty id without spaces');
  }
  return settings;
}

export function loadSecrets(env: Env): Secrets {
  const aiGatewayApiKey = text(env, 'AI_GATEWAY_API_KEY');
  if (!aiGatewayApiKey) throw new Error('Set AI_GATEWAY_API_KEY for Jev via Vercel AI Gateway');
  return { aiGatewayApiKey };
}

export function loadConfig(env: Env = process.env, settings: SorterSettings = sorterSettings): SorterConfig {
  assertNoRetiredEnv(env);
  return { ...validateSettings(settings), secrets: loadSecrets(env) };
}
