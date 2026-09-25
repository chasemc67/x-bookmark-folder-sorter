import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  type ConnectTokenResponse,
  type getTokenResponse,
  type startAuthorization,
} from '@vercel/connect';
import { sorterSettings } from '../config/sorter.js';
import { handleAuthorizeXRequest, type AuthorizeDeps } from '../src/connectAuthorize.js';
import { silentLog } from '../src/log.js';
import { X_SCOPES } from '../src/x/auth.js';

const env = { CRON_SECRET: 's3cret' };
const url = 'https://x.test/api/connect/authorize-x';
const authed = () => new Request(url, { headers: { authorization: 'Bearer s3cret' } });
const settings = { ...sorterSettings, xConnectSubjectId: 'chase', xUserId: '' };

const token: ConnectTokenResponse = {
  token: 'x-access-secret',
  tokenId: 'stk_1',
  expiresAt: 7_200_000,
  externalSubject: '249951215',
  connector: { id: 'cn_1', uid: 'oauth/x-bookmarks', type: 'oauth' },
};

function deps(overrides: AuthorizeDeps): AuthorizeDeps {
  return {
    env,
    settings,
    log: silentLog,
    getTokenResponse: async () => { throw new Error('getTokenResponse not expected'); },
    startAuthorization: async () => { throw new Error('startAuthorization not expected'); },
    ...overrides,
  };
}

test('authorize-x requires the cron bearer and fails closed without CRON_SECRET', async () => {
  let called = false;
  const spy: typeof getTokenResponse = async () => { called = true; return token; };
  assert.equal((await handleAuthorizeXRequest(new Request(url), deps({ getTokenResponse: spy }))).status, 401);
  assert.equal((await handleAuthorizeXRequest(new Request(`${url}?token=s3cret`), deps({ getTokenResponse: spy }))).status, 401);
  assert.equal((await handleAuthorizeXRequest(authed(), deps({ env: {}, getTokenResponse: spy }))).status, 500);
  assert.equal(called, false);
});

test('authorize-x returns ok JSON without the token when the grant already works', async () => {
  const calls: Parameters<typeof getTokenResponse>[] = [];
  const fake: typeof getTokenResponse = async (...args) => { calls.push(args); return token; };
  const response = await handleAuthorizeXRequest(authed(), deps({ getTokenResponse: fake }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /x-access-secret/);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.subject, 'chase');
  assert.equal(body.xUserId, '249951215');
  const [connector, params, options] = calls[0]!;
  assert.equal(connector, 'oauth/x-bookmarks');
  assert.deepEqual(params.subject, { type: 'user', id: 'chase' });
  assert.deepEqual(params.scopes, [...X_SCOPES]);
  assert.equal(options?.forceRefresh, true, 'must re-check the grant, not a warm-instance cached token');
});

test('authorize-x redirects to the Connect consent URL when the grant is missing', async () => {
  for (const error of [
    new UserAuthorizationRequiredError('User authorization is required', { code: 'user_authorization_required', status: 403 }),
    new NoValidTokenError('No valid token available', { code: 'no_token', status: 404 }),
  ]) {
    const started: Parameters<typeof startAuthorization>[] = [];
    const start: typeof startAuthorization = async (...args) => {
      started.push(args);
      return { request: 'req_1', verifier: 'v', url: 'https://vercel.com/connect/authorize/req_1' };
    };
    const response = await handleAuthorizeXRequest(authed(), deps({
      getTokenResponse: async () => { throw error; },
      startAuthorization: start,
    }));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://vercel.com/connect/authorize/req_1');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.authorizeUrl, 'https://vercel.com/connect/authorize/req_1');
    const [connector, params] = started[0]!;
    assert.equal(connector, 'oauth/x-bookmarks');
    assert.deepEqual(params.subject, { type: 'user', id: 'chase' });
    assert.deepEqual(params.scopes, [...X_SCOPES]);
  }
});

test('authorize-x reports other Connect failures instead of starting authorization', async () => {
  const response = await handleAuthorizeXRequest(authed(), deps({
    getTokenResponse: async () => { throw new ConnectError('Connector not found', { status: 404 }); },
  }));
  assert.equal(response.status, 500);
  const body = await response.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /HTTP 404.*xConnectConnector/);
});
