import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { sorterSettings } from '../config/sorter.js';
import { createTokenStore } from '../src/app.js';
import { requestToken, X_AUTHORIZE_URL, X_SCOPES } from '../src/x/auth.js';
import { fetchAuthenticatedUserId } from '../src/x/client.js';
import { loadLocalEnv } from './env.js';

/**
 * One-time local OAuth 2.0 PKCE flow. Saves tokens to the Upstash/KV store the cron uses when
 * KV_REST_API_URL/TOKEN are in .env, otherwise to the gitignored .x-tokens.json.
 * Re-run it whenever the stored refresh token is revoked.
 */
loadLocalEnv();

const clientId = process.env.X_CLIENT_ID?.trim();
const clientSecret = process.env.X_CLIENT_SECRET?.trim() || undefined;
const redirectUri = sorterSettings.xRedirectUri;
if (!clientId) {
  console.error('Set X_CLIENT_ID (and X_CLIENT_SECRET for a confidential client) in .env first.');
  process.exit(2);
}
const kvUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const kvToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const store = createTokenStore({ kv: kvUrl && kvToken ? { url: kvUrl, token: kvToken } : undefined }, sorterSettings.xTokenStoreKey, false);

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');
const authorizeUrl = new URL(X_AUTHORIZE_URL);
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: X_SCOPES.join(' '),
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();

const callback = new URL(redirectUri);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== callback.pathname) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error(url.searchParams.get('error') ?? 'No authorization code returned');
    const tokens = await requestToken(
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier },
      { clientId, clientSecret },
    );
    await store.save(tokens);
    console.log(store.kind === 'upstash'
      ? 'Saved tokens to the Upstash/KV token store used by the cron.'
      : 'Saved tokens to .x-tokens.json (local runs only; add KV_REST_API_URL/TOKEN to .env to seed the cron).');
    const userId = await fetchAuthenticatedUserId({ getAccessToken: async () => tokens.accessToken });
    console.log(`Your X user id is ${userId}; optionally set xUserId in config/sorter.ts to skip the lookup.`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Authorized. You can close this tab.\n');
  } catch (error) {
    console.error(`Authorization failed: ${(error as Error).message}`);
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Authorization failed; see terminal.\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(callback.port || 80), callback.hostname, () => {
  console.log(`Register this callback URL on your X app: ${redirectUri}`);
  console.log(`Open this URL and approve access:\n\n${authorizeUrl}\n`);
});
