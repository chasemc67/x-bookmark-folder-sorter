import { readFile, writeFile } from 'node:fs/promises';

export interface StoredXTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface TokenStore {
  readonly kind: string;
  load(): Promise<StoredXTokens | undefined>;
  save(tokens: StoredXTokens): Promise<void>;
}

function parseStored(raw: unknown): StoredXTokens | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredXTokens>;
    if (typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && typeof value.expiresAt === 'number') {
      return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
    }
  } catch {
    // Treat corrupt entries as missing so the env seed refresh token can recover.
  }
  return undefined;
}

/** Upstash Redis REST (also what Vercel KV / Marketplace Upstash provisions). */
export class UpstashTokenStore implements TokenStore {
  readonly kind = 'upstash';

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly key: string,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private async command(args: string[]): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Token store ${args[0]} failed with HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown };
    return body.result;
  }

  async load(): Promise<StoredXTokens | undefined> {
    return parseStored(await this.command(['GET', this.key]));
  }

  async save(tokens: StoredXTokens): Promise<void> {
    await this.command(['SET', this.key, JSON.stringify(tokens)]);
  }
}

/** Local development only; the file is gitignored. */
export class FileTokenStore implements TokenStore {
  readonly kind = 'file';

  constructor(private readonly path: string) {}

  async load(): Promise<StoredXTokens | undefined> {
    try {
      return parseStored(await readFile(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }

  async save(tokens: StoredXTokens): Promise<void> {
    await writeFile(this.path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly kind = 'memory';
  constructor(private tokens?: StoredXTokens) {}
  async load(): Promise<StoredXTokens | undefined> {
    return this.tokens;
  }
  async save(tokens: StoredXTokens): Promise<void> {
    this.tokens = tokens;
  }
}
