import type { Log } from '../log.js';
import type { StoredXTokens, TokenStore } from './tokenStore.js';
import type { AccessTokenProvider } from './types.js';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
/** offline.access is what makes X issue a refresh token for unattended cron runs. */
export const X_SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'bookmark.write', 'offline.access'] as const;

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface OAuthClientCredentials {
  clientId: string;
  /** Present for confidential ("Web App") clients; omit for public ("Native App") clients. */
  clientSecret?: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export async function requestToken(
  params: Record<string, string>,
  client: OAuthClientCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<StoredXTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
  }
  const response = await fetchImpl(X_TOKEN_URL, { method: 'POST', headers, body, redirect: 'error' });
  const json = (await response.json().catch(() => ({}))) as TokenResponse & { error?: unknown; error_description?: unknown };
  if (!response.ok || typeof json.access_token !== 'string') {
    // Error bodies from the token endpoint never echo secrets, but keep them short anyway.
    const reason = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : 'unknown';
    throw new Error(`X token request failed (HTTP ${response.status}): ${reason.slice(0, 200)}`);
  }
  if (typeof json.refresh_token !== 'string') {
    throw new Error('X token response had no refresh_token; authorize with the offline.access scope');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 7200;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: now() + expiresIn * 1000 };
}

export interface RefreshingTokenProviderOptions {
  client: OAuthClientCredentials;
  store: TokenStore;
  log?: Log;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * X rotates refresh tokens on every use, so each refreshed pair is persisted before
 * the new access token is handed out; otherwise the next cron run could not auth.
 */
export class RefreshingTokenProvider implements AccessTokenProvider {
  private current?: StoredXTokens;
  private inflight?: Promise<string>;
  private readonly now: () => number;

  constructor(private readonly options: RefreshingTokenProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    this.inflight ??= this.resolve().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async resolve(): Promise<string> {
    this.current ??= await this.options.store.load();
    if (this.current && this.current.expiresAt - REFRESH_SKEW_MS > this.now()) return this.current.accessToken;
    const refreshToken = this.current?.refreshToken;
    if (!refreshToken) throw new Error('No X refresh token in the token store: run `npm run auth:x`');
    const next = await requestToken(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      this.options.client,
      this.options.fetch,
      this.now,
    );
    await this.options.store.save(next);
    this.current = next;
    this.options.log?.('x_token_refreshed', { store: this.options.store.kind, expiresAt: new Date(next.expiresAt).toISOString() });
    return next.accessToken;
  }
}
