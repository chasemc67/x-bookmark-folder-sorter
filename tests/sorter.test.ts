import assert from 'node:assert/strict';
import test from 'node:test';
import { silentLog } from '../src/log.js';
import { runSorter, type SorterRunConfig } from '../src/sorter/run.js';
import { answer, fakeXApi, scriptedJev } from './helpers.js';

const baseConfig: SorterRunConfig = {
  dryRun: true,
  minConfidence: 0.7,
  misfiledMinConfidence: 0.9,
  checkMisfiled: true,
  refileMisfiled: false,
  maxBookmarksPerRun: 200,
  maxWritesPerRun: 50,
  jevBatchSize: 2,
  maxTextChars: 400,
  folderDescriptions: {},
  excludedFolders: [],
};

const pick = (tweetId: string) => {
  switch (tweetId) {
    case '1001': return answer('AI', { AI: 0.95, Cooking: 0.03, keep_unfiled: 0.01, skip: 0.01 });
    case '1002': return answer('Cooking', { AI: 0.02, Cooking: 0.9, keep_unfiled: 0.05, skip: 0.03 });
    case '1003': return answer('AI', { AI: 0.5, Cooking: 0.3, keep_unfiled: 0.15, skip: 0.05 });
    case '1004': return answer('Cooking', { AI: 0.03, Cooking: 0.95, keep_unfiled: 0.01, skip: 0.01 });
    default: return undefined;
  }
};

test('dry run plans assignments but never sends a write to X', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const summary = await runSorter(baseConfig, { x: x.client, jev: jev.client, log: silentLog });

  assert.equal(x.requests.filter(r => r.method !== 'GET').length, 0);
  assert.equal(summary.bookmarksListed, 4);
  assert.equal(summary.unfiled, 3);
  const kinds = Object.fromEntries(summary.actions.map(a => [a.tweetId, a.kind]));
  assert.deepEqual(kinds, { '1001': 'file', '1002': 'file', '1003': 'low_confidence', '1004': 'misfiled_report' });
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.targetFolderId, '9001');
  assert.equal(summary.writes.attempted, 0);
  // 4 items, batch size 2 -> 2 Jev calls, unfiled items first.
  assert.equal(jev.calls.length, 2);
});

test('live mode only adds high-confidence unfiled bookmarks via POST with folder_id, never DELETE', async () => {
  const x = fakeXApi();
  const summary = await runSorter({ ...baseConfig, dryRun: false }, { x: x.client, jev: scriptedJev(pick).client, log: silentLog });

  assert.equal(x.requests.some(r => r.method === 'DELETE'), false);
  const posts = x.requests.filter(r => r.method === 'POST');
  assert.deepEqual(posts.map(r => r.body), [
    { tweet_id: '1001', folder_id: '9001' },
    { tweet_id: '1002', folder_id: '9002' },
  ]);
  assert.deepEqual(summary.writes, { attempted: 2, added: 2, failed: 0, deferred: 0 });
  assert.deepEqual(x.folders['9001'], ['1004', '1001']);
});

test('second live run is an idempotent no-op once bookmarks are in their target folders', async () => {
  const x = fakeXApi();
  const deps = { x: x.client, jev: scriptedJev(pick).client, log: silentLog };
  await runSorter({ ...baseConfig, dryRun: false }, deps);
  const before = x.requests.filter(r => r.method === 'POST').length;
  const summary = await runSorter({ ...baseConfig, dryRun: false }, deps);

  assert.equal(x.requests.filter(r => r.method === 'POST').length, before);
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.kind, 'already_in_folder');
  assert.equal(summary.actions.find(a => a.tweetId === '1002')?.kind, 'already_in_folder');
});

test('misfiled bookmarks are refiled only when REFILE_MISFILED is enabled', async () => {
  const x = fakeXApi();
  await runSorter({ ...baseConfig, dryRun: false, refileMisfiled: true }, { x: x.client, jev: scriptedJev(pick).client, log: silentLog });
  const posts = x.requests.filter(r => r.method === 'POST').map(r => r.body as { folder_id: string; tweet_ids?: string[]; tweet_id?: string });
  const cooking = posts.find(body => body.folder_id === '9002');
  assert.deepEqual(cooking, { tweet_ids: ['1002', '1004'], folder_id: '9002' });
});

test('failed Jev batches and missing answers fail closed with no writes', async () => {
  const x = fakeXApi();
  const jev = {
    provider: 'jev' as const,
    async decide(): Promise<never> {
      throw new Error('synthetic outage');
    },
  };
  const summary = await runSorter({ ...baseConfig, dryRun: false }, { x: x.client, jev, log: silentLog });
  assert.equal(x.requests.filter(r => r.method === 'POST').length, 0);
  assert.ok(summary.actions.every(a => a.kind === 'no_decision'));
});

test('MAX_WRITES_PER_RUN defers extra writes', async () => {
  const x = fakeXApi();
  const summary = await runSorter({ ...baseConfig, dryRun: false, maxWritesPerRun: 1 }, { x: x.client, jev: scriptedJev(pick).client, log: silentLog });
  assert.equal(summary.writes.attempted, 1);
  assert.equal(summary.writes.deferred, 1);
  assert.equal(summary.actions.find(a => a.tweetId === '1002')?.write, 'deferred');
});

test('excluded folders are never targets and their bookmarks are left alone', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const summary = await runSorter({ ...baseConfig, excludedFolders: ['ai'] }, { x: x.client, jev: jev.client, log: silentLog });
  const criteria = Object.keys(Object.values(jev.calls[0]!.questions)[0]!.criteria);
  assert.deepEqual(criteria, ['Cooking', 'keep_unfiled', 'skip']);
  assert.equal(summary.actions.some(a => a.tweetId === '1004'), false);
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.kind, 'no_decision');
});
