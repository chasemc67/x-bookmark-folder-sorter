import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  type ConnectTokenResponse,
  type getTokenResponse,
} from '@vercel/connect';
import { sorterSettings, type SorterSettings } from '../config/sorter.js';
import { loadConfig, RETIRED_ENV_VARS, RETIRED_SETTINGS } from '../src/config.js';
import { checkCronAuth } from '../src/cronAuth.js';
import { handleSortRequest } from '../src/handler.js';
import { silentLog } from '../src/log.js';
import type { RunSummary } from '../src/sorter/run.js';
import { ConnectTokenProvider, X_SCOPES, XAuthorizationRequiredError } from '../src/x/auth.js';

const secretsEnv = { AI_GATEWAY_API_KEY: 'k' };

test('checked-in defaults are valid and safe: dry run, unfiled-only, no misfile/refile settings', () => {
  const config = loadConfig(secretsEnv);
  assert.equal(config.dryRun, true);
  assert.equal(config.minConfidence, 0.7);
  for (const name of Object.keys(RETIRED_SETTINGS)) assert.equal(name in config, false, name);
  assert.equal(config.xConnectConnector, 'oauth/x-bookmarks');
  assert.equal(config.xConnectSubjectId, 'MRaz5FqERysDw0algrlADHti');
  assert.equal(config.xUserId, '249951215');
  assert.deepEqual(config.secrets, { aiGatewayApiKey: 'k' });
});

test('env holds only secrets; retired env vars (tunables, X OAuth, KV) fail loudly instead of being ignored', () => {
  assert.throws(() => loadConfig({}), /AI_GATEWAY_API_KEY/);
  for (const name of Object.keys(RETIRED_ENV_VARS)) {
    assert.throws(() => loadConfig({ ...secretsEnv, [name]: 'x' }), new RegExp(`retired env vars.*${name}`));
  }
  for (const name of ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REFRESH_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL']) {
    assert.ok(name in RETIRED_ENV_VARS, name);
  }
  assert.throws(() => loadConfig({ ...secretsEnv, KV_REST_API_URL: 'https://kv.test' }), /disconnect the Upstash\/KV integration/);
});

test('retired misfile/refile settings cannot be turned back on: startup rejects them', () => {
  assert.deepEqual(Object.keys(RETIRED_SETTINGS).sort(), ['checkMisfiled', 'misfiledMinConfidence', 'refileMisfiled']);
  for (const [name, value] of [['checkMisfiled', true], ['refileMisfiled', true], ['misfiledMinConfidence', 0.9], ['refileMisfiled', false]] as const) {
    const settings = { ...sorterSettings, [name]: value } as unknown as SorterSettings;
    assert.throws(() => loadConfig(secretsEnv, settings), new RegExp(`retired settings.*${name}.*only files unfiled`));
  }
  for (const name of ['CHECK_MISFILED', 'REFILE_MISFILED', 'MISFILED_MIN_CONFIDENCE']) {
    assert.throws(() => loadConfig({ ...secretsEnv, [name]: 'true' }), /only files unfiled bookmarks/);
  }
});

test('invalid config values are rejected at startup', () => {
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, minConfidence: 1.5 }), /minConfidence/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, jevBatchSize: 0 }), /jevBatchSize/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, xUserId: '@chase' }), /xUserId/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, xConnectConnector: '' }), /xConnectConnector/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, xConnectSubjectId: 'two words' }), /xConnectSubjectId/);
});

test('cron auth fails closed without CRON_SECRET and rejects wrong bearer tokens', () => {
  assert.deepEqual(checkCronAuth('Bearer x', undefined), { ok: false, status: 500, error: 'CRON_SECRET is not configured' });
  assert.equal(checkCronAuth(null, 's3cret').ok, false);
  assert.equal(checkCronAuth('Bearer wrong', 's3cret').ok, false);
  assert.equal(checkCronAuth('Bearer s3cret', 's3cret').ok, true);
});

test('handler rejects unauthenticated calls and ?dry_run=1 forces dry run', async () => {
  const calls: { forceDryRun?: boolean }[] = [];
  const run = async (_env: unknown, options: { forceDryRun?: boolean }) => {
    calls.push(options);
    return { dryRun: true, actions: [] } as unknown as RunSummary;
  };
  const env = { CRON_SECRET: 's3cret' };
  const denied = await handleSortRequest(new Request('https://x.test/api/cron/sort-bookmarks'), { env, run, log: silentLog });
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  const ok = await handleSortRequest(
    new Request('https://x.test/api/cron/sort-bookmarks?dry_run=1', { headers: { authorization: 'Bearer s3cret' } }),
    { env, run, log: silentLog },
  );
  assert.equal(ok.status, 200);
  assert.equal(calls[0]!.forceDryRun, true);
});

type FakeGetToken = typeof getTokenResponse;

function tokenResponse(n: number): ConnectTokenResponse {
  return {
    token: `x-access-${n}`,
    tokenId: `stk_${n}`,
    expiresAt: 7_200_000,
    connector: { id: 'cn_1', uid: 'oauth/x-bookmarks', type: 'oauth' },
  };
}

test('Connect provider asks for the configured user subject with X scopes and returns the token', async () => {
  const calls: { connector: string; params: Parameters<FakeGetToken>[1] }[] = [];
  const events: string[] = [];
  const fake: FakeGetToken = async (connector, params) => {
    calls.push({ connector, params });
    return tokenResponse(1);
  };
  const provider = new ConnectTokenProvider({
    connector: 'oauth/x-bookmarks',
    subjectId: 'chase',
    getTokenResponse: fake,
    log: event => events.push(event),
  });
  assert.equal(await provider.getAccessToken(), 'x-access-1');
  assert.equal(await provider.getAccessToken(), 'x-access-1');
  assert.equal(calls[0]!.connector, 'oauth/x-bookmarks');
  assert.deepEqual(calls[0]!.params.subject, { type: 'user', id: 'chase' });
  assert.deepEqual(calls[0]!.params.scopes, [...X_SCOPES]);
  assert.ok((calls[0]!.params.validityBufferMs ?? 0) >= 300_000, 'token must outlive a 300s run');
  assert.deepEqual(events, ['x_token_issued'], 'logs once per issued token, not per X request');
});

test('missing or revoked X grant fails the run with instructions to authorize', async () => {
  for (const error of [
    new UserAuthorizationRequiredError('User authorization is required', { code: 'user_authorization_required', status: 403 }),
    new NoValidTokenError('No valid token available', { code: 'no_token', status: 404 }),
  ]) {
    const provider = new ConnectTokenProvider({
      connector: 'oauth/x-bookmarks',
      subjectId: 'chase',
      getTokenResponse: async () => { throw error; },
    });
    await assert.rejects(provider.getAccessToken(), (e: Error) => {
      assert.ok(e instanceof XAuthorizationRequiredError);
      assert.match(e.message, /subject "chase".*oauth\/x-bookmarks.*npm run connect:x/);
      return true;
    });
  }
});

test('other Connect and OIDC failures are reported with a setup hint, not as auth prompts', async () => {
  const cases: [Error, RegExp][] = [
    [new ConnectorInstallationRequiredError('install it'), /needs to be installed or attached/],
    [new ConnectError('Connector not found', { status: 404 }), /HTTP 404.*xConnectConnector/],
    [new Error('The \'x-vercel-oidc-token\' header is missing'), /vercel env pull/],
  ];
  for (const [error, pattern] of cases) {
    const provider = new ConnectTokenProvider({
      connector: 'oauth/x-bookmarks',
      subjectId: 'chase',
      getTokenResponse: async () => { throw error; },
    });
    await assert.rejects(provider.getAccessToken(), (e: Error) => {
      assert.ok(!(e instanceof XAuthorizationRequiredError));
      assert.match(e.message, pattern);
      return true;
    });
  }
});

test('handler fails the cron run with the authorization message when X is not connected', async () => {
  const logged: Record<string, unknown>[] = [];
  const run = async () => {
    throw new XAuthorizationRequiredError('X is not authorized for Connect subject "chase": run `npm run connect:x`');
  };
  const response = await handleSortRequest(
    new Request('https://x.test/api/cron/sort-bookmarks', { headers: { authorization: 'Bearer s3cret' } }),
    { env: { CRON_SECRET: 's3cret' }, run, log: (_event, fields) => logged.push(fields ?? {}) },
  );
  assert.equal(response.status, 500);
  const body = await response.json() as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /npm run connect:x/);
  assert.equal(logged[0]!.error, 'XAuthorizationRequiredError');
});
