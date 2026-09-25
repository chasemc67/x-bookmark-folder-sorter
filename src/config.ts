import { sorterSettings, type SorterSettings } from '../config/sorter.js';

export type Env = Record<string, string | undefined>;

/** The only values read from env: real credentials. Everything else is in config/sorter.ts. */
export interface Secrets {
  aiGatewayApiKey: string;
  xClientId: string;
  xClientSecret?: string;
  /** Upstash Redis REST credentials (Vercel Marketplace sets KV_REST_API_URL/TOKEN). */
  kv?: { url: string; token: string };
}

export type SorterConfig = SorterSettings & { secrets: Secrets };

/**
 * Former env knobs. Setting one now fails the run instead of being silently ignored, so a stale
 * Vercel env var (e.g. DRY_RUN=true while config says live) can never change behavior unnoticed.
 */
export const RETIRED_ENV_VARS = [
  'DRY_RUN',
  'JEV_MODEL',
  'JEV_TIMEOUT_MS',
  'GATEWAY_ZERO_DATA_RETENTION',
  'MIN_CONFIDENCE',
  'MISFILED_MIN_CONFIDENCE',
  'CHECK_MISFILED',
  'REFILE_MISFILED',
  'MAX_BOOKMARKS_PER_RUN',
  'MAX_WRITES_PER_RUN',
  'JEV_BATCH_SIZE',
  'MAX_TEXT_CHARS',
  'FOLDER_DESCRIPTIONS',
  'EXCLUDED_FOLDERS',
  'X_USER_ID',
  'X_REFRESH_TOKEN',
  'X_ACCESS_TOKEN',
  'X_TOKEN_STORE_KEY',
  'X_REDIRECT_URI',
  'JEV_API_KEY',
  'TYPESAFE_API_KEY',
  'JEV_PROVIDER',
] as const;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function assertNoRetiredEnv(env: Env): void {
  const present = RETIRED_ENV_VARS.filter(name => env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(`Remove retired env vars (these now live in config/sorter.ts): ${present.join(', ')}`);
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
  if (!settings.xTokenStoreKey.trim()) throw new Error('config/sorter.ts: xTokenStoreKey must not be empty');
  return settings;
}

export function loadSecrets(env: Env): Secrets {
  const aiGatewayApiKey = text(env, 'AI_GATEWAY_API_KEY');
  if (!aiGatewayApiKey) throw new Error('Set AI_GATEWAY_API_KEY for Jev via Vercel AI Gateway');
  const xClientId = text(env, 'X_CLIENT_ID');
  if (!xClientId) throw new Error('Set X_CLIENT_ID (your X app OAuth 2.0 client id)');
  // Some Upstash integrations inject UPSTASH_REDIS_REST_* instead of KV_REST_API_*.
  const url = text(env, 'KV_REST_API_URL') ?? text(env, 'UPSTASH_REDIS_REST_URL');
  const token = text(env, 'KV_REST_API_TOKEN') ?? text(env, 'UPSTASH_REDIS_REST_TOKEN');
  return {
    aiGatewayApiKey,
    xClientId,
    xClientSecret: text(env, 'X_CLIENT_SECRET'),
    kv: url && token ? { url, token } : undefined,
  };
}

export function loadConfig(env: Env = process.env, settings: SorterSettings = sorterSettings): SorterConfig {
  assertNoRetiredEnv(env);
  return { ...validateSettings(settings), secrets: loadSecrets(env) };
}
