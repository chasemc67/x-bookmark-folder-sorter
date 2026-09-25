import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenProvider } from '../src/app.js';
import { sorterSettings } from '../config/sorter.js';
import { loadConfig, RETIRED_ENV_VARS } from '../src/config.js';
import { checkCronAuth } from '../src/cronAuth.js';
import { handleSortRequest } from '../src/handler.js';
import { silentLog } from '../src/log.js';
import type { RunSummary } from '../src/sorter/run.js';
import { RefreshingTokenProvider, X_TOKEN_URL } from '../src/x/auth.js';
import { MemoryTokenStore, UpstashTokenStore } from '../src/x/tokenStore.js';

const secretsEnv = { AI_GATEWAY_API_KEY: 'k', X_CLIENT_ID: 'cid' };

test('checked-in defaults are valid and safe: dry run, add-only thresholds, report-only refiles', () => {
  const config = loadConfig(secretsEnv);
  assert.equal(config.dryRun, true);
  assert.equal(config.minConfidence, 0.7);
  assert.equal(config.misfiledMinConfidence, 0.9);
  assert.equal(config.refileMisfiled, false);
  assert.deepEqual(config.secrets, { aiGatewayApiKey: 'k', xClientId: 'cid', xClientSecret: undefined, kv: undefined });
});

test('env holds only secrets; retired tunables in env fail loudly instead of being ignored', () => {
  assert.throws(() => loadConfig({}), /AI_GATEWAY_API_KEY/);
  assert.throws(() => loadConfig({ AI_GATEWAY_API_KEY: 'k' }), /X_CLIENT_ID/);
  for (const name of RETIRED_ENV_VARS) {
    assert.throws(() => loadConfig({ ...secretsEnv, [name]: 'x' }), new RegExp(`retired env vars.*${name}`));
  }
  const kv = loadConfig({ ...secretsEnv, KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' }).secrets.kv;
  assert.deepEqual(kv, { url: 'https://kv.test', token: 't' });
});

test('invalid config values are rejected at startup', () => {
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, minConfidence: 1.5 }), /minConfidence/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, jevBatchSize: 0 }), /jevBatchSize/);
  assert.throws(() => loadConfig(secretsEnv, { ...sorterSettings, xUserId: '@chase' }), /xUserId/);
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

test('refreshing provider persists the rotated refresh token before using it', async () => {
  const store = new MemoryTokenStore({ accessToken: 'stale', refreshToken: 'seed-refresh', expiresAt: 0 });
  const bodies: string[] = [];
  let n = 0;
  const provider = new RefreshingTokenProvider({
    client: { clientId: 'cid' },
    store,
    now: () => 0,
    fetch: async (url, init) => {
      assert.equal(String(url), X_TOKEN_URL);
      bodies.push(String(init?.body));
      n += 1;
      return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 7200 });
    },
  });
  assert.equal(await provider.getAccessToken(), 'access-1');
  assert.equal(await provider.getAccessToken(), 'access-1');
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /grant_type=refresh_token&refresh_token=seed-refresh&client_id=cid/);
  assert.deepEqual(await store.load(), { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 7_200_000 });
});

test('X tokens come only from the token store: Vercel requires KV, and an empty store asks for auth:x', async () => {
  await assert.rejects(createTokenProvider({ xClientId: 'cid' }, { key: 'k', onVercel: true }), /persistent token store/);
  const emptyKv: typeof globalThis.fetch = async () => Response.json({ result: null });
  const store = new UpstashTokenStore('https://kv.test', 't', 'k', emptyKv);
  assert.equal(await store.load(), undefined);
  const provider = new RefreshingTokenProvider({ client: { clientId: 'cid' }, store });
  await assert.rejects(provider.getAccessToken(), /npm run auth:x/);
});
