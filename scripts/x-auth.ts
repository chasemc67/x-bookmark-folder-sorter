import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { LOCAL_TOKEN_FILE } from '../src/app.js';
import { requestToken, X_AUTHORIZE_URL, X_SCOPES } from '../src/x/auth.js';
import { fetchAuthenticatedUserId } from '../src/x/client.js';
import { FileTokenStore, UpstashTokenStore } from '../src/x/tokenStore.js';
import { loadLocalEnv } from './env.js';

/**
 * One-time local OAuth 2.0 PKCE flow. Saves tokens to the KV/Upstash store the cron uses
 * when its env vars are present, otherwise to the gitignored .x-tokens.json.
 */
const { values } = parseArgs({ options: { 'print-refresh-token': { type: 'boolean', default: false } } });
loadLocalEnv();

const clientId = process.env.X_CLIENT_ID?.trim();
const clientSecret = process.env.X_CLIENT_SECRET?.trim() || undefined;
const redirectUri = process.env.X_REDIRECT_URI?.trim() || 'http://127.0.0.1:8787/callback';
if (!clientId) {
  console.error('Set X_CLIENT_ID (and X_CLIENT_SECRET for a confidential client) in .env first.');
  process.exit(2);
}

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
    // Refresh tokens are single-use, so exactly one store may hold them.
    const kvUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
    const kvToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    if (kvUrl && kvToken) {
      await new UpstashTokenStore(kvUrl, kvToken, process.env.X_TOKEN_STORE_KEY ?? 'x-bookmark-folder-sorter:x-oauth').save(tokens);
      console.log('Saved tokens to the Upstash/KV token store used by the cron.');
    } else {
      await new FileTokenStore(LOCAL_TOKEN_FILE).save(tokens);
      console.log(`Saved tokens to ${LOCAL_TOKEN_FILE} (local runs only).`);
    }
    const userId = await fetchAuthenticatedUserId({ getAccessToken: async () => tokens.accessToken });
    console.log(`X_USER_ID=${userId}`);
    if (values['print-refresh-token']) {
      console.log(`X_REFRESH_TOKEN=${tokens.refreshToken}`);
      console.log('This refresh token is single-use: seed it into exactly one place (Vercel env or KV).');
    }
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
