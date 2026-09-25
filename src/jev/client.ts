import { createGateway } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';
import type { Log } from '../log.js';
import type { ChoiceAnswer, ChoiceQuestion, DecideResult, JevClient, JevInput, JevProvider } from './types.js';

export const JEV_PROXY_URL = 'https://jevtypesafeai.com/api/v1/decide';
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const GATEWAY_JEV_MODEL = 'typesafe-ai/jev';

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** TypeSafe's documented Choice confidence: (n * peak - 1) / (n - 1), clamped to [0, 1]. */
export function choiceConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  if (values.length < 2) return values.length === 1 ? 1 : 0;
  const peak = Math.max(...values);
  return Math.max(0, Math.min(1, (values.length * peak - 1) / (values.length - 1)));
}

/** Rejects anything that is not a well-formed Choice answer over exactly the asked options. */
export function parseChoiceAnswer(question: ChoiceQuestion, raw: unknown): ChoiceAnswer | undefined {
  if (!isRecord(raw) || raw.type !== 'choice' || typeof raw.choice !== 'string') return undefined;
  const options = Object.keys(question.criteria);
  if (!options.includes(raw.choice)) return undefined;
  const rawProbabilities = raw.probabilities;
  if (!isRecord(rawProbabilities)) return undefined;
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const value = rawProbabilities[option] ?? 0;
    if (!isProbability(value)) return undefined;
    probabilities[option] = value;
  }
  const computed = choiceConfidence(probabilities);
  const confidence = isProbability(raw.confidence) ? raw.confidence : computed;
  return { choice: raw.choice, probabilities, confidence };
}

function parseAnswers(questions: Record<string, ChoiceQuestion>, answers: unknown): Record<string, ChoiceAnswer> {
  if (!isRecord(answers)) throw new JevError('Jev response had no answers map');
  const parsed: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseChoiceAnswer(question, answers[id]);
    if (answer) parsed[id] = answer;
  }
  return parsed;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface HttpJevClientOptions {
  provider: 'jev' | 'typesafe';
  apiKey: string;
  url?: string;
  /** Sent as `model` for the official API; the jevtypesafeai.com proxy picks its own. */
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  log?: Log;
  fetch?: typeof globalThis.fetch;
}

/** Raw HTTP client for the jevtypesafeai.com proxy and the official TypeSafe API (same request shape). */
export class HttpJevClient implements JevClient {
  readonly provider: 'jev' | 'typesafe';
  private readonly url: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: HttpJevClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error(options.provider === 'jev' ? 'JEV_API_KEY is required' : 'TYPESAFE_API_KEY is required');
    }
    this.provider = options.provider;
    this.url = options.url ?? (options.provider === 'jev' ? JEV_PROXY_URL : TYPESAFE_URL);
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(state: JevInput, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<DecideResult> {
    const body = JSON.stringify({
      state,
      ...(this.options.model ? { model: this.options.model } : {}),
      questions,
    });
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(this.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey.trim()}`, 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: withTimeout(this.options.timeoutMs ?? 20_000, signal),
        });
      } catch (error) {
        if (signal?.aborted || attempt >= maxAttempts) throw new JevError(`Jev request failed: ${(error as Error).name}`);
        await delay(250 * 2 ** attempt, signal);
        continue;
      }
      if (response.ok) {
        const json = (await response.json()) as { answers?: unknown; usage?: { input_tokens?: unknown; cost_usd?: unknown } };
        return {
          answers: parseAnswers(questions, json.answers),
          inputTokens: typeof json.usage?.input_tokens === 'number' ? json.usage.input_tokens : undefined,
          costUsd: typeof json.usage?.cost_usd === 'number' ? json.usage.cost_usd : undefined,
        };
      }
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        this.options.log?.('jev_retry', { provider: this.provider, status: response.status, attempt });
        await delay(250 * 2 ** attempt, signal);
        continue;
      }
      if (response.status === 402) throw new JevError('Jev prepaid balance is empty (HTTP 402); top up at jevtypesafeai.com/pricing', 402);
      if (response.status === 401) throw new JevError('Jev rejected the API key (HTTP 401)', 401);
      throw new JevError(`Jev request failed with HTTP ${response.status}`, response.status);
    }
  }
}

export interface GatewayJevClientOptions {
  /** Omit on Vercel to authenticate with the deployment's OIDC token. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  zeroDataRetention?: boolean;
  fetch?: typeof globalThis.fetch;
}

/** Vercel AI Gateway `typesafe-ai/jev` through the AI SDK, matching Jevis. */
export class GatewayJevClient implements JevClient {
  readonly provider = 'gateway' as const;

  constructor(private readonly options: GatewayJevClientOptions = {}) {}

  async decide(state: JevInput, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<DecideResult> {
    const gateway = createGateway({
      ...(this.options.apiKey?.trim() ? { apiKey: this.options.apiKey.trim() } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    try {
      const result = await evaluate({
        model: gateway.evaluationModel(this.options.model ?? GATEWAY_JEV_MODEL),
        state,
        questions,
        maxRetries: 2,
        abortSignal: withTimeout(this.options.timeoutMs ?? 20_000, signal),
        providerOptions: {
          gateway: {
            only: ['typesafe-ai'],
            ...(this.options.zeroDataRetention ? { zeroDataRetention: true } : {}),
          },
        },
      });
      return {
        answers: parseAnswers(questions, result.answers),
        inputTokens: result.usage.inputTokens,
      };
    } catch (error) {
      if (error instanceof JevError) throw error;
      // SDK errors can embed request headers or payloads; surface only the error class.
      throw new JevError(`AI Gateway Jev evaluation failed: ${(error as Error).name}`);
    }
  }
}

export interface JevEnvConfig {
  provider: JevProvider;
  apiKey?: string;
  url?: string;
  model?: string;
  timeoutMs: number;
  zeroDataRetention: boolean;
}

export function createJevClient(config: JevEnvConfig, log?: Log): JevClient {
  switch (config.provider) {
    case 'jev':
    case 'typesafe':
      return new HttpJevClient({
        provider: config.provider,
        apiKey: config.apiKey ?? '',
        url: config.url,
        model: config.provider === 'typesafe' ? config.model ?? TYPESAFE_DEFAULT_MODEL : config.model,
        timeoutMs: config.timeoutMs,
        log,
      });
    case 'gateway':
      return new GatewayJevClient({
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
        zeroDataRetention: config.zeroDataRetention,
      });
  }
}
