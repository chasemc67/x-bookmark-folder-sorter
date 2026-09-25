import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChoiceAnswer, ChoiceQuestion, JevClient } from '../src/jev/types.js';
import { silentLog } from '../src/log.js';
import { runSorter, type SorterRunConfig } from '../src/sorter/run.js';
import { XClient } from '../src/x/client.js';
import { answer, fakeXApi, POSTS, scriptedJev, USER_ID } from './helpers.js';

const baseConfig: SorterRunConfig = {
  dryRun: true,
  minConfidence: 0.7,
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
    // 1004 is filed under AI; Jev would confidently pick Cooking if it were ever asked.
    case '1004': return answer('Cooking', { AI: 0.01, Cooking: 0.97, keep_unfiled: 0.01, skip: 0.01 });
    default: return undefined;
  }
};

/** Every bookmark id Jev was asked about, and every post text it was shown, across all calls. */
function sentToJev(calls: ReturnType<typeof scriptedJev>['calls']) {
  const ids = calls.flatMap(call => Object.keys(call.questions).map(id => id.replace(/^bookmark_/, '')));
  const texts = calls.flatMap(call => (call.state as { bookmarks: { text: string }[] }).bookmarks.map(b => b.text));
  return { ids, texts };
}

const writes = (x: ReturnType<typeof fakeXApi>) => x.requests.filter(r => r.method !== 'GET');

test('dry run plans assignments for unfiled bookmarks only and never sends a write to X', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const summary = await runSorter(baseConfig, { x: x.client, jev: jev.client, log: silentLog });

  assert.equal(writes(x).length, 0);
  assert.equal(summary.bookmarksListed, 4);
  assert.equal(summary.unfiled, 3);
  assert.equal(summary.classified, 3);
  const kinds = Object.fromEntries(summary.actions.map(a => [a.tweetId, a.kind]));
  assert.deepEqual(kinds, { '1001': 'file', '1002': 'file', '1003': 'low_confidence' });
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.targetFolderId, '9001');
  assert.equal(summary.writes.attempted, 0);
  // 3 unfiled items, batch size 2 -> 2 Jev calls.
  assert.equal(jev.calls.length, 2);
});

test('live mode only adds high-confidence unfiled bookmarks via POST with folder_id, never DELETE', async () => {
  const x = fakeXApi();
  const summary = await runSorter({ ...baseConfig, dryRun: false }, { x: x.client, jev: scriptedJev(pick).client, log: silentLog });

  assert.equal(x.requests.some(r => r.method === 'DELETE'), false);
  assert.deepEqual(writes(x).map(r => r.body), [
    { tweet_id: '1001', folder_id: '9001' },
    { tweet_id: '1002', folder_id: '9002' },
  ]);
  assert.deepEqual(summary.writes, { attempted: 2, added: 2, failed: 0, deferred: 0, skippedNowFiled: 0 });
  assert.deepEqual(x.folders, { '9001': ['1004', '1001'], '9002': ['1002'] });
});

test('invariant: a bookmark already in a folder is never classified, planned, or written', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const summary = await runSorter({ ...baseConfig, dryRun: false, minConfidence: 0 }, { x: x.client, jev: jev.client, log: silentLog });

  const { ids, texts } = sentToJev(jev.calls);
  assert.equal(ids.includes('1004'), false, 'filed bookmark must not be sent to Jev');
  assert.equal(texts.some(text => text.includes('pasta')), false, 'filed bookmark text must not be in the Jev state');
  assert.equal(summary.actions.some(a => a.tweetId === '1004'), false, 'filed bookmark must not be planned or reported');
  for (const request of writes(x)) {
    const body = request.body as { tweet_id?: string; tweet_ids?: string[] };
    assert.equal([body.tweet_id, ...(body.tweet_ids ?? [])].includes('1004'), false, 'filed bookmark must never be a write target');
  }
  assert.deepEqual(x.folders['9001']!.filter(id => id === '1004'), ['1004']);
  assert.equal(x.folders['9002']!.includes('1004'), false);
});

test('invariant: when every bookmark is filed, nothing is classified or written', async () => {
  // Each bookmark filed somewhere, one in two folders; Jev would move several of them if asked.
  const x = fakeXApi({ '9001': ['1002', '1003', '1004'], '9002': ['1001', '1003'] });
  const jev = scriptedJev(pick);
  const summary = await runSorter({ ...baseConfig, dryRun: false, minConfidence: 0 }, { x: x.client, jev: jev.client, log: silentLog });

  assert.equal(summary.unfiled, 0);
  assert.equal(summary.classified, 0);
  assert.deepEqual(summary.actions, []);
  assert.equal(jev.calls.length, 0);
  assert.equal(writes(x).length, 0);
  assert.deepEqual(x.folders, { '9001': ['1002', '1003', '1004'], '9002': ['1001', '1003'] });
});

test('invariant: bookmarks in excluded folders are filed, so they are left alone too', async () => {
  const x = fakeXApi({ '9002': ['1001'] });
  const jev = scriptedJev(pick);
  const summary = await runSorter({ ...baseConfig, dryRun: false, excludedFolders: ['Cooking'] }, { x: x.client, jev: jev.client, log: silentLog });

  assert.equal(sentToJev(jev.calls).ids.includes('1001'), false);
  assert.equal(summary.actions.some(a => a.tweetId === '1001'), false);
  assert.deepEqual(x.folders['9002'], ['1001']);
  assert.equal(x.folders['9001']!.includes('1001'), false);
});

test('a bookmark filed by hand while the run is in progress is skipped, not added to a second folder', async () => {
  const x = fakeXApi();
  const inner = scriptedJev(pick).client;
  const jev: JevClient = {
    model: inner.model,
    async decide(state, questions) {
      // Simulate the user filing 1001 into Cooking after the sorter listed folders.
      if (!x.folders['9002']!.includes('1001')) x.folders['9002']!.push('1001');
      return inner.decide(state, questions);
    },
  };
  const summary = await runSorter({ ...baseConfig, dryRun: false }, { x: x.client, jev, log: silentLog });

  assert.deepEqual(writes(x).map(r => r.body), [{ tweet_id: '1002', folder_id: '9002' }]);
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.write, 'skipped_now_filed');
  assert.equal(summary.writes.skippedNowFiled, 1);
  assert.equal(x.folders['9001']!.includes('1001'), false);
});

test('second live run is an idempotent no-op once bookmarks are filed', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const deps = { x: x.client, jev: jev.client, log: silentLog };
  await runSorter({ ...baseConfig, dryRun: false }, deps);
  const before = writes(x).length;
  const callsBefore = jev.calls.length;
  const summary = await runSorter({ ...baseConfig, dryRun: false }, deps);

  assert.equal(writes(x).length, before);
  assert.equal(summary.unfiled, 1);
  assert.deepEqual(summary.actions.map(a => [a.tweetId, a.kind]), [['1003', 'low_confidence']]);
  assert.deepEqual(sentToJev(jev.calls.slice(callsBefore)).ids, ['1003']);
});

test('failed Jev batches and missing answers fail closed with no writes', async () => {
  const x = fakeXApi();
  const jev = {
    model: 'typesafe-ai/jev',
    async decide(): Promise<never> {
      throw new Error('synthetic outage');
    },
  };
  const summary = await runSorter({ ...baseConfig, dryRun: false }, { x: x.client, jev, log: silentLog });
  assert.equal(writes(x).length, 0);
  assert.ok(summary.actions.every(a => a.kind === 'no_decision'));
});

test('maxWritesPerRun defers extra writes', async () => {
  const x = fakeXApi();
  const summary = await runSorter({ ...baseConfig, dryRun: false, maxWritesPerRun: 1 }, { x: x.client, jev: scriptedJev(pick).client, log: silentLog });
  assert.equal(summary.writes.attempted, 1);
  assert.equal(summary.writes.deferred, 1);
  assert.equal(summary.actions.find(a => a.tweetId === '1002')?.write, 'deferred');
});

test('excluded folders are never targets', async () => {
  const x = fakeXApi();
  const jev = scriptedJev(pick);
  const summary = await runSorter({ ...baseConfig, excludedFolders: ['ai'] }, { x: x.client, jev: jev.client, log: silentLog });
  const criteria = Object.keys(Object.values(jev.calls[0]!.questions)[0]!.criteria);
  assert.deepEqual(criteria, ['Cooking', 'keep_unfiled', 'skip']);
  assert.equal(summary.actions.find(a => a.tweetId === '1001')?.kind, 'no_decision');
});

test('an incomplete folder listing fails the run before any Jev call or write', async () => {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === `/2/users/${USER_ID}/bookmarks/folders`) return Response.json({ data: [{ id: '9001', name: 'AI' }] });
    // Folder listing keeps handing back the same next_token, so it can never be completed.
    if (url.pathname === `/2/users/${USER_ID}/bookmarks/folders/9001`) return Response.json({ data: [{ id: '1004' }], meta: { next_token: 'loop' } });
    return Response.json({ data: POSTS });
  };
  const x = new XClient({ tokens: { getAccessToken: async () => 't' }, userId: USER_ID, fetch });
  const jev = scriptedJev(() => undefined as ChoiceAnswer | undefined);
  await assert.rejects(
    runSorter({ ...baseConfig, dryRun: false }, { x, jev: jev.client, log: silentLog }),
    /listing is incomplete/,
  );
  assert.equal(jev.calls.length, 0);
  assert.equal(requests.some(r => !r.startsWith('GET')), false);
});

test('questions never describe a bookmark as already filed', async () => {
  const jev = scriptedJev(pick);
  await runSorter(baseConfig, { x: fakeXApi().client, jev: jev.client, log: silentLog });
  for (const call of jev.calls) {
    for (const question of Object.values(call.questions) as ChoiceQuestion[]) {
      assert.match(String(question.instructions), /currently unfiled/);
      assert.doesNotMatch(String(question.instructions), /already in/);
    }
    for (const bookmark of (call.state as { bookmarks: Record<string, unknown>[] }).bookmarks) {
      assert.equal('current_folders' in bookmark, false);
    }
  }
});
