import type { Log } from '../log.js';
import type { AccessTokenProvider, AddToFolderResult, Bookmark, BookmarkFolder } from './types.js';

export const X_API_BASE_URL = 'https://api.x.com';
/** X caps bulk bookmark creation at 25 IDs per request. */
export const MAX_TWEET_IDS_PER_ADD = 25;
/** GET /2/users/:id/bookmarks only returns the most recent 800 bookmarks. */
export const MAX_LISTABLE_BOOKMARKS = 800;

export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`X API ${status} on ${endpoint}: ${detail}`);
  }
}

export interface XClientOptions {
  tokens: AccessTokenProvider;
  userId: string;
  log?: Log;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

interface Page<T> {
  data?: T[];
  includes?: { users?: { id: string; username: string }[] };
  meta?: { next_token?: string };
  errors?: { detail?: string; title?: string; resource_id?: string; tweet_id?: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeDetail(body: unknown): string {
  if (isRecord(body)) {
    const detail = body.detail ?? body.title ?? (Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0].message ?? body.errors[0].detail : undefined);
    if (typeof detail === 'string') return detail.slice(0, 300);
  }
  return 'request failed';
}

/**
 * Deliberately exposes no delete or unbookmark operation: the sorter may only read
 * bookmarks and add already-bookmarked posts into folders.
 */
export class XClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: XClientOptions) {
    if (!/^[0-9]{1,19}$/.test(options.userId)) throw new Error('X user id must be numeric');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? X_API_BASE_URL;
  }

  get userId(): string {
    return this.options.userId;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await this.options.tokens.getAccessToken();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const endpoint = `${method} ${path.split('?')[0]}`;
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 429) {
        this.options.log?.('x_rate_limited', { endpoint, reset: response.headers.get('x-rate-limit-reset') });
      }
      throw new XApiError(response.status, endpoint, safeDetail(parsed));
    }
    return parsed as T;
  }

  private async *paginate<T>(path: string, params: Record<string, string>): AsyncGenerator<Page<T>> {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams(params);
      if (token) query.set('pagination_token', token);
      const page = await this.request<Page<T>>('GET', `${path}?${query}`);
      yield page;
      token = page.meta?.next_token;
      // A truncated folder listing would make filed bookmarks look unfiled, so fail the run instead.
      if (token && seen.has(token)) throw new XApiError(0, `GET ${path}`, 'pagination repeated a next_token; listing is incomplete');
      if (token) seen.add(token);
    } while (token);
  }

  async listFolders(): Promise<BookmarkFolder[]> {
    const folders: BookmarkFolder[] = [];
    for await (const page of this.paginate<BookmarkFolder>(`/2/users/${this.userId}/bookmarks/folders`, { max_results: '100' })) {
      for (const folder of page.data ?? []) folders.push({ id: folder.id, name: folder.name });
    }
    return folders;
  }

  async listFolderPostIds(folderId: string): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of this.paginate<{ id: string }>(
      `/2/users/${this.userId}/bookmarks/folders/${encodeURIComponent(folderId)}`,
      { max_results: '100' },
    )) {
      for (const post of page.data ?? []) ids.push(post.id);
    }
    return ids;
  }

  async listBookmarks(limit = MAX_LISTABLE_BOOKMARKS): Promise<Bookmark[]> {
    const bookmarks: Bookmark[] = [];
    const params = {
      max_results: '100',
      'tweet.fields': 'author_id,note_tweet',
      expansions: 'author_id',
      'user.fields': 'username',
    };
    for await (const page of this.paginate<{ id: string; text?: string; author_id?: string; note_tweet?: { text?: string } }>(
      `/2/users/${this.userId}/bookmarks`,
      params,
    )) {
      const usernames = new Map((page.includes?.users ?? []).map(user => [user.id, user.username]));
      for (const post of page.data ?? []) {
        bookmarks.push({
          id: post.id,
          text: post.note_tweet?.text ?? post.text ?? '',
          authorId: post.author_id,
          authorUsername: post.author_id ? usernames.get(post.author_id) : undefined,
        });
        if (bookmarks.length >= limit) return bookmarks;
      }
    }
    return bookmarks;
  }

  /** Adds already-bookmarked posts into a folder. Never removes a bookmark. */
  async addToFolder(folderId: string, tweetIds: string[]): Promise<AddToFolderResult> {
    if (!/^[0-9]{1,19}$/.test(folderId)) throw new Error('Invalid folder id');
    if (tweetIds.length === 0 || tweetIds.length > MAX_TWEET_IDS_PER_ADD) {
      throw new Error(`addToFolder accepts 1-${MAX_TWEET_IDS_PER_ADD} tweet ids`);
    }
    if (!tweetIds.every(id => /^[0-9]{1,19}$/.test(id))) throw new Error('Invalid tweet id');
    const body = tweetIds.length === 1
      ? { tweet_id: tweetIds[0], folder_id: folderId }
      : { tweet_ids: tweetIds, folder_id: folderId };
    const response = await this.request<{ data?: unknown; errors?: Page<never>['errors'] }>(
      'POST',
      `/2/users/${this.userId}/bookmarks`,
      body,
    );
    const failed = (response.errors ?? []).map(error => ({
      tweetId: String(error.tweet_id ?? error.resource_id ?? ''),
      detail: String(error.detail ?? error.title ?? 'failed').slice(0, 300),
    }));
    let added: string[];
    if (Array.isArray(response.data)) {
      added = response.data
        .filter((item): item is { tweet_id: string; bookmarked: boolean } => isRecord(item) && item.bookmarked === true)
        .map(item => String(item.tweet_id));
    } else if (isRecord(response.data) && response.data.bookmarked === true) {
      added = [...tweetIds];
    } else {
      added = [];
    }
    return { folderId, added, failed };
  }
}

export async function fetchAuthenticatedUserId(
  tokens: AccessTokenProvider,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const token = await tokens.getAccessToken();
  const response = await fetchImpl(`${X_API_BASE_URL}/2/users/me`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new XApiError(response.status, 'GET /2/users/me', safeDetail(body));
  const id = isRecord(body) && isRecord(body.data) ? body.data.id : undefined;
  if (typeof id !== 'string') throw new Error('X /2/users/me returned no id');
  return id;
}
