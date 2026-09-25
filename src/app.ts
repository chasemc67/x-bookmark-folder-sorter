import { loadConfig, type Env, type XEnvConfig } from './config.js';
import { GatewayJevClient } from './jev/client.js';
import type { Log } from './log.js';
import { runSorter, type RunSummary } from './sorter/run.js';
import { RefreshingTokenProvider, StaticTokenProvider } from './x/auth.js';
import { fetchAuthenticatedUserId, XClient } from './x/client.js';
import { FileTokenStore, UpstashTokenStore, type TokenStore } from './x/tokenStore.js';
import type { AccessTokenProvider } from './x/types.js';

export const LOCAL_TOKEN_FILE = '.x-tokens.json';

export async function createTokenProvider(
  x: XEnvConfig,
  options: { onVercel: boolean; log?: Log },
): Promise<AccessTokenProvider> {
  if (x.clientId) {
    let store: TokenStore | undefined;
    if (x.store) store = new UpstashTokenStore(x.store.url, x.store.token, x.store.key);
    else if (!options.onVercel) store = new FileTokenStore(LOCAL_TOKEN_FILE);
    const hasStoredTokens = store ? (await store.load()) !== undefined : false;
    if (store && (x.refreshToken || hasStoredTokens)) {
      return new RefreshingTokenProvider({
        client: { clientId: x.clientId, clientSecret: x.clientSecret },
        store,
        seedRefreshToken: x.refreshToken,
        log: options.log,
      });
    }
    if (!store && x.refreshToken && !x.accessToken) {
      throw new Error(
        'X refresh tokens rotate on every use, so a Vercel deployment needs a persistent token store: '
        + 'connect Upstash Redis / Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN) or set X_ACCESS_TOKEN.',
      );
    }
  }
  if (x.accessToken) return new StaticTokenProvider(x.accessToken);
  throw new Error('Configure X auth: X_CLIENT_ID + X_REFRESH_TOKEN (+ token store on Vercel), or X_ACCESS_TOKEN');
}

export async function runFromEnv(
  env: Env,
  options: { forceDryRun?: boolean; forceLive?: boolean; log: Log },
): Promise<RunSummary> {
  const config = loadConfig(env);
  if (options.forceDryRun) config.dryRun = true;
  else if (options.forceLive) config.dryRun = false;
  const onVercel = Boolean(env.VERCEL);
  const tokens = await createTokenProvider(config.x, { onVercel, log: options.log });
  const userId = config.x.userId ?? await fetchAuthenticatedUserId(tokens);
  const x = new XClient({ tokens, userId, log: options.log });
  const jev = new GatewayJevClient({ ...config.jev, log: options.log });
  return runSorter(config, { x, jev, log: options.log });
}
