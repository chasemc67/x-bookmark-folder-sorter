import { loadConfig, type Env, type Secrets } from './config.js';
import { GatewayJevClient } from './jev/client.js';
import type { Log } from './log.js';
import { runSorter, type RunSummary } from './sorter/run.js';
import { RefreshingTokenProvider } from './x/auth.js';
import { fetchAuthenticatedUserId, XClient } from './x/client.js';
import { FileTokenStore, UpstashTokenStore, type TokenStore } from './x/tokenStore.js';
import type { AccessTokenProvider } from './x/types.js';

export const LOCAL_TOKEN_FILE = '.x-tokens.json';

/** KV when configured; the gitignored local file only for runs off Vercel. */
export function createTokenStore(secrets: Pick<Secrets, 'kv'>, key: string, onVercel: boolean): TokenStore {
  if (secrets.kv) return new UpstashTokenStore(secrets.kv.url, secrets.kv.token, key);
  if (onVercel) {
    throw new Error(
      'X refresh tokens rotate on every use, so the Vercel deployment needs a persistent token store: '
      + 'connect Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN).',
    );
  }
  return new FileTokenStore(LOCAL_TOKEN_FILE);
}

export async function createTokenProvider(
  secrets: Pick<Secrets, 'xClientId' | 'xClientSecret' | 'kv'>,
  options: { key: string; onVercel: boolean; log?: Log },
): Promise<AccessTokenProvider> {
  const store = createTokenStore(secrets, options.key, options.onVercel);
  if ((await store.load()) === undefined) {
    throw new Error(`No X tokens in the ${store.kind} token store: run \`npm run auth:x\` once`);
  }
  return new RefreshingTokenProvider({
    client: { clientId: secrets.xClientId, clientSecret: secrets.xClientSecret },
    store,
    log: options.log,
  });
}

export async function runFromEnv(
  env: Env,
  options: { forceDryRun?: boolean; forceLive?: boolean; log: Log },
): Promise<RunSummary> {
  const config = loadConfig(env);
  if (options.forceDryRun) config.dryRun = true;
  else if (options.forceLive) config.dryRun = false;
  const tokens = await createTokenProvider(config.secrets, {
    key: config.xTokenStoreKey,
    onVercel: Boolean(env.VERCEL),
    log: options.log,
  });
  const userId = config.xUserId || await fetchAuthenticatedUserId(tokens);
  const x = new XClient({ tokens, userId, log: options.log });
  const jev = new GatewayJevClient({
    apiKey: config.secrets.aiGatewayApiKey,
    timeoutMs: config.jevTimeoutMs,
    zeroDataRetention: config.gatewayZeroDataRetention,
    log: options.log,
  });
  return runSorter(config, { x, jev, log: options.log });
}
