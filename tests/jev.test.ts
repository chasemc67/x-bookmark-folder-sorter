import assert from 'node:assert/strict';
import test from 'node:test';
import { choiceConfidence, EVALUATION_URL, GatewayJevClient, JEV_MODEL, JevError, parseChoiceAnswer } from '../src/jev/client.js';
import type { ChoiceQuestion } from '../src/jev/types.js';

const question: ChoiceQuestion = {
  type: 'choice',
  instructions: 'Pick a folder',
  criteria: { AI: 'ai', keep_unfiled: 'none', skip: 'cannot judge' },
};

function response(answers: Record<string, unknown> = {
  q: { type: 'choice', choice: 'AI', probabilities: { AI: 0.9, keep_unfiled: 0.1, skip: 0 } },
}): Response {
  return Response.json({ answers, usage: { inputTokens: 42, outputTokens: 5 } });
}

function httpError(status: number): Response {
  return Response.json({ error: { message: 'test failure' } }, { status });
}

test('sends one authenticated Gateway-only evaluate request for typesafe-ai/jev', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = new GatewayJevClient({ apiKey: 'test-gateway-token', zeroDataRetention: true }, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response();
    },
  });
  const result = await client.decide({ bookmarks: [] }, { q: question });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, EVALUATION_URL);
  assert.equal(request.url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  assert.equal(request.init?.redirect, 'error');
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-gateway-token');
  assert.equal(headers.get('ai-model-id'), JEV_MODEL);
  const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.providerOptions, { gateway: { only: ['typesafe-ai'], zeroDataRetention: true } });
  assert.deepEqual(body.state, { bookmarks: [] });
  assert.equal(result.answers.q?.choice, 'AI');
  assert.equal(result.answers.q?.confidence.toFixed(2), '0.85');
  assert.equal(result.inputTokens, 42);
});

for (const status of [429, 500, 503]) {
  test(`retries HTTP ${status} exactly once, then fails closed`, async () => {
    let calls = 0;
    const client = new GatewayJevClient({ apiKey: 't' }, { random: () => 0, fetch: async () => (calls += 1, httpError(status)) });
    await assert.rejects(client.decide('s', { q: question }), (error: unknown) => error instanceof JevError && error.status === status);
    assert.equal(calls, 2);
  });
}

test('a retry that succeeds returns answers', async () => {
  let calls = 0;
  const client = new GatewayJevClient({ apiKey: 't' }, { random: () => 0, fetch: async () => ++calls === 1 ? httpError(503) : response() });
  const result = await client.decide('s', { q: question });
  assert.equal(calls, 2);
  assert.equal(result.answers.q?.choice, 'AI');
});

for (const status of [400, 401, 403]) {
  test(`HTTP ${status} fails closed without retry`, async () => {
    let calls = 0;
    const client = new GatewayJevClient({ apiKey: 't' }, { fetch: async () => (calls += 1, httpError(status)) });
    await assert.rejects(client.decide('s', { q: question }), (error: unknown) => error instanceof JevError && error.status === status);
    assert.equal(calls, 1);
  });
}

test('network errors never expose raw provider text or the key', async () => {
  const client = new GatewayJevClient({ apiKey: 'secret-token' }, {
    fetch: async () => {
      throw new Error('Sensitive payload secret-token');
    },
  });
  await assert.rejects(client.decide('s', { q: question }), (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.doesNotMatch(error.message, /Sensitive|secret-token/);
    return true;
  });
});

test('deadline aborts the transport and fails closed', async () => {
  let aborted = false;
  const client = new GatewayJevClient({ apiKey: 't', timeoutMs: 20 }, {
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });
  await assert.rejects(client.decide('s', { q: question }), /timed out/);
  assert.equal(aborted, true);
});

test('requires AI_GATEWAY_API_KEY', () => {
  assert.throws(() => new GatewayJevClient({ apiKey: ' ' }), /AI_GATEWAY_API_KEY/);
});

test('parseChoiceAnswer rejects unknown choices and answers without probabilities', () => {
  assert.equal(parseChoiceAnswer(question, { type: 'choice', choice: 'Nope', probabilities: { AI: 1 } }), undefined);
  assert.equal(parseChoiceAnswer(question, { type: 'choice', choice: 'AI' }), undefined);
  assert.equal(parseChoiceAnswer(question, { type: 'choice', choice: 'AI', probabilities: { AI: 1.5 } }), undefined);
  const parsed = parseChoiceAnswer(question, { type: 'choice', choice: 'AI', probabilities: { AI: 0.9, keep_unfiled: 0.1 } });
  assert.deepEqual(parsed?.probabilities, { AI: 0.9, keep_unfiled: 0.1, skip: 0 });
});

test('choiceConfidence follows the documented (n*peak-1)/(n-1) shape', () => {
  assert.equal(choiceConfidence({ a: 1, b: 0, c: 0 }), 1);
  assert.equal(choiceConfidence({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 0);
});
