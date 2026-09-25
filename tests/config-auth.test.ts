import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenProvider } from '../src/app.js';
import { loadConfig, parseDryRun } from '../src/config.js';
import { checkCronAuth } from '../src/cronAuth.js';
import { handleSortRequest } from '../src/handler.js';
import { silentLog } from '../src/log.js';
import type { RunSummary } from '../src/sorter/run.js';
import { RefreshingTokenProvider, X_TOKEN_URL } from '../src/x/auth.js';
import { MemoryTokenStore } from '../src/x/tokenStore.js';

test('dry run is the default; only an explicit false enables live mode', () => {
  assert.equal(parseDryRun(undefined), true);
  assert.equal(parseDryRun(''), true);
  assert.equal(parseDryRun('flase'), true);
  assert.equal(parseDryRun('true'), true);
  assert.equal(parseDryRun('false'), false);
  assert.equal(parseDryRun('0'), false);
});

test('Jev provider is inferred from available keys', () => {
  assert.equal(loadConfig({ JEV_API_KEY: 'jv' }).jev.provider, 'jev');
  assert.equal(loadConfig({ TYPESAFE_API_KEY: 'ts' }).jev.provider, 'typesafe');
  assert.equal(loadConfig({ VERCEL_OIDC_TOKEN: 'oidc' }).jev.provider, 'gateway');
  assert.equal(loadConfig({ JEV_PROVIDER: 'gateway', JEV_API_KEY: 'jv' }).jev.provider, 'gateway');
  assert.throws(() => loadConfig({}), /JEV_API_KEY/);
  const config = loadConfig({ JEV_API_KEY: 'jv' });
  assert.equal(config.dryRun, true);
  assert.equal(config.minConfidence, 0.7);
  assert.equal(config.refileMisfiled, false);
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
  const store = new MemoryTokenStore();
  const bodies: string[] = [];
  let n = 0;
  const provider = new RefreshingTokenProvider({
    client: { clientId: 'cid' },
    store,
    seedRefreshToken: 'seed-refresh',
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

test('Vercel deployments refuse refresh-token auth without a persistent store', async () => {
  await assert.rejects(
    createTokenProvider({ clientId: 'cid', refreshToken: 'r' }, { onVercel: true }),
    /persistent token store/,
  );
  const provider = await createTokenProvider({ accessToken: 'static' }, { onVercel: true });
  assert.equal(await provider.getAccessToken(), 'static');
});
