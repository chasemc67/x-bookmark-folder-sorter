import assert from 'node:assert/strict';
import test from 'node:test';
import { choiceConfidence, HttpJevClient, JEV_PROXY_URL, JevError, parseChoiceAnswer, TYPESAFE_URL } from '../src/jev/client.js';
import type { ChoiceQuestion } from '../src/jev/types.js';

const question: ChoiceQuestion = {
  type: 'choice',
  instructions: 'Pick a folder',
  criteria: { AI: 'ai', keep_unfiled: 'none', skip: 'cannot judge' },
};

test('HTTP client posts the documented body with bearer auth to the Jev proxy', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const client = new HttpJevClient({
    provider: 'jev',
    apiKey: 'jv_test_key',
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return Response.json({
        answers: { q: { type: 'choice', choice: 'AI', confidence: 0.8, probabilities: { AI: 0.9, keep_unfiled: 0.1, skip: 0 } } },
        usage: { input_tokens: 42, cost_usd: 0.00001 },
      });
    },
  });
  const result = await client.decide({ bookmarks: [] }, { q: question });
  assert.equal(seen[0]!.url, JEV_PROXY_URL);
  assert.equal(new Headers(seen[0]!.init?.headers).get('authorization'), 'Bearer jv_test_key');
  const body = JSON.parse(String(seen[0]!.init?.body));
  assert.deepEqual(body, { state: { bookmarks: [] }, questions: { q: question } });
  assert.deepEqual(result.answers.q, { choice: 'AI', confidence: 0.8, probabilities: { AI: 0.9, keep_unfiled: 0.1, skip: 0 } });
  assert.equal(result.inputTokens, 42);
});

test('TypeSafe provider sends the model and uses the official endpoint', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const client = new HttpJevClient({
    provider: 'typesafe',
    apiKey: 'ts_test',
    model: 'jev-latest',
    fetch: async (u, init) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return Response.json({ answers: {} });
    },
  });
  await client.decide('s', { q: question });
  assert.equal(url, TYPESAFE_URL);
  assert.equal(body.model, 'jev-latest');
});

test('retries 529 then surfaces 402 as a typed error', async () => {
  const statuses = [529, 402];
  const client = new HttpJevClient({
    provider: 'jev',
    apiKey: 'k',
    fetch: async () => new Response('{}', { status: statuses.shift() ?? 500 }),
  });
  await assert.rejects(client.decide('s', { q: question }), (error: unknown) => error instanceof JevError && error.status === 402);
});

test('parseChoiceAnswer rejects unknown choices and computes missing confidence', () => {
  assert.equal(parseChoiceAnswer(question, { type: 'choice', choice: 'Nope', probabilities: { AI: 1 } }), undefined);
  assert.equal(parseChoiceAnswer(question, { type: 'choice', choice: 'AI' }), undefined);
  const parsed = parseChoiceAnswer(question, { type: 'choice', choice: 'AI', probabilities: { AI: 0.9, keep_unfiled: 0.1 } });
  assert.deepEqual(parsed?.probabilities, { AI: 0.9, keep_unfiled: 0.1, skip: 0 });
  assert.equal(parsed?.confidence.toFixed(2), '0.85');
});

test('choiceConfidence follows the documented (n*peak-1)/(n-1) shape', () => {
  assert.equal(choiceConfidence({ a: 1, b: 0, c: 0 }), 1);
  assert.equal(choiceConfidence({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 0);
});
