import {
  ConnectError,
  ConnectorInstallationRequiredError,
  getTokenResponse,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  type ConnectTokenParams,
} from '@vercel/connect';
import type { Log } from '../log.js';
import type { AccessTokenProvider } from './types.js';

/** Endpoints and scopes to configure on the Vercel Connect Custom OAuth connector. */
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
/** offline.access is what makes X issue the refresh token Connect uses for unattended cron runs. */
export const X_SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'bookmark.write', 'offline.access'] as const;

/** A cached token must outlive the whole run (function maxDuration is 300s). */
const VALIDITY_BUFFER_MS = 10 * 60 * 1000;

/** One Connect connector serves many X accounts; each account is one `user` subject. */
export interface XConnectTarget {
  connector: string;
  subjectId: string;
}

export function xTokenParams(subjectId: string): ConnectTokenParams {
  return { subject: { type: 'user', id: subjectId }, scopes: [...X_SCOPES] };
}

export class XAuthorizationRequiredError extends Error {
  override readonly name = 'XAuthorizationRequiredError';
}

export function isAuthorizationRequired(error: unknown): boolean {
  return error instanceof UserAuthorizationRequiredError
    || error instanceof NoValidTokenError
    || error instanceof XAuthorizationRequiredError;
}

export function describeConnectError(error: unknown, { connector, subjectId }: XConnectTarget): Error {
  if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
    return new XAuthorizationRequiredError(
      `X is not authorized for Connect subject "${subjectId}" on connector "${connector}" (${error.message}). `
      + 'Run `npm run connect:x` and approve access in the browser, then rerun.',
    );
  }
  if (error instanceof ConnectorInstallationRequiredError) {
    return new Error(`Vercel Connect connector "${connector}" needs to be installed or attached to this project: ${error.message}`);
  }
  if (error instanceof ConnectError) {
    const code = error.code ?? (error.status === undefined ? 'error' : `HTTP ${error.status}`);
    return new Error(
      `Vercel Connect token request for "${connector}" failed (${code}): ${error.message}. `
      + 'Check xConnectConnector in config/sorter.ts and that the connector is attached to this project.',
    );
  }
  return new Error(
    `Could not get an X token from Vercel Connect: ${(error as Error).message}. `
    + 'Locally, run `vercel link` and `vercel env pull` so VERCEL_OIDC_TOKEN is in .env.local.',
  );
}

export interface ConnectTokenProviderOptions extends XConnectTarget {
  log?: Log;
  getTokenResponse?: typeof getTokenResponse;
}

/**
 * Called before every X request. The Connect SDK caches the token in-process, so a run
 * normally makes one billed token request; Connect holds and rotates the X refresh token.
 */
export class ConnectTokenProvider implements AccessTokenProvider {
  private lastTokenId?: string;

  constructor(private readonly options: ConnectTokenProviderOptions) {}

  async getAccessToken(): Promise<string> {
    const { connector, subjectId, log } = this.options;
    const fetchToken = this.options.getTokenResponse ?? getTokenResponse;
    let response;
    try {
      response = await fetchToken(connector, { ...xTokenParams(subjectId), validityBufferMs: VALIDITY_BUFFER_MS });
    } catch (error) {
      throw describeConnectError(error, this.options);
    }
    const tokenId = response.tokenId ?? String(response.expiresAt);
    if (tokenId !== this.lastTokenId) {
      this.lastTokenId = tokenId;
      log?.('x_token_issued', {
        connector: response.connector.uid,
        subject: subjectId,
        tokenId: response.tokenId,
        expiresAt: new Date(response.expiresAt).toISOString(),
      });
    }
    return response.token;
  }
}
