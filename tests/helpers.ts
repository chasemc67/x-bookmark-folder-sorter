import type { ChoiceAnswer, ChoiceQuestion, DecideResult, JevClient, JevInput } from '../src/jev/types.js';
import { XClient } from '../src/x/client.js';

/** Synthetic data only: IDs and text are made up for tests and do not refer to real posts. */
export const USER_ID = '100';
export const FOLDERS = [
  { id: '9001', name: 'AI' },
  { id: '9002', name: 'Cooking' },
];
export const POSTS = [
  { id: '1001', text: 'synthetic post about transformer models', author_id: '501' },
  { id: '1002', text: 'synthetic post about sourdough', author_id: '502' },
  { id: '1003', text: 'synthetic ambiguous post', author_id: '501' },
  { id: '1004', text: 'synthetic post about pasta, currently filed under AI', author_id: '502' },
];
export const USERS = [
  { id: '501', username: 'synthetic_ml' },
  { id: '502', username: 'synthetic_chef' },
];

export interface RecordedRequest {
  method: string;
  url: URL;
  body?: unknown;
}

/** Minimal in-memory X API that records every request and applies folder adds. */
export function fakeXApi(membership: Record<string, string[]> = { '9001': ['1004'] }) {
  const requests: RecordedRequest[] = [];
  const folders = Object.fromEntries(FOLDERS.map(f => [f.id, [...(membership[f.id] ?? [])]]));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const path = url.pathname;
    if (method === 'GET' && path === `/2/users/${USER_ID}/bookmarks/folders`) {
      return Response.json({ data: FOLDERS });
    }
    const folderMatch = path.match(new RegExp(`^/2/users/${USER_ID}/bookmarks/folders/(\\d+)$`));
    if (method === 'GET' && folderMatch) {
      return Response.json({ data: (folders[folderMatch[1]!] ?? []).map(id => ({ id })) });
    }
    if (method === 'GET' && path === `/2/users/${USER_ID}/bookmarks`) {
      // Two pages to exercise pagination.
      const second = url.searchParams.get('pagination_token') === 'page2';
      const data = second ? POSTS.slice(2) : POSTS.slice(0, 2);
      return Response.json({ data, includes: { users: USERS }, meta: second ? {} : { next_token: 'page2' } });
    }
    if (method === 'POST' && path === `/2/users/${USER_ID}/bookmarks`) {
      const ids: string[] = body.tweet_ids ?? [body.tweet_id];
      if (body.folder_id) folders[body.folder_id]?.push(...ids);
      return Response.json(body.tweet_ids
        ? { data: ids.map(tweet_id => ({ tweet_id, bookmarked: true })) }
        : { data: { bookmarked: true } });
    }
    return Response.json({ title: 'not found' }, { status: 404 });
  };
  const client = new XClient({ tokens: { getAccessToken: async () => 'test-x-token' }, userId: USER_ID, fetch });
  return { client, requests, folders };
}

export function answer(choice: string, probabilities: Record<string, number>): ChoiceAnswer & { type: 'choice' } {
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  return { type: 'choice', choice, probabilities, confidence: sum > 0 ? Math.max(...Object.values(probabilities)) : 0 };
}

/** Jev stub that answers each question by tweet id via a callback. */
export function scriptedJev(pick: (tweetId: string, question: ChoiceQuestion) => ChoiceAnswer | undefined) {
  const calls: { state: JevInput; questions: Record<string, ChoiceQuestion> }[] = [];
  const client: JevClient = {
    provider: 'jev',
    async decide(state, questions): Promise<DecideResult> {
      calls.push({ state, questions });
      const answers: Record<string, ChoiceAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const result = pick(id.replace(/^bookmark_/, ''), question);
        if (result) answers[id] = result;
      }
      return { answers, inputTokens: 10 };
    },
  };
  return { client, calls };
}
