import { createGateway } from '@ai-sdk/gateway';
import { experimental_evaluate as evaluate } from 'ai';
import type { Log } from '../log.js';
import type { ChoiceAnswer, ChoiceQuestion, DecideResult, JevClient, JevInput } from './types.js';

export const JEV_MODEL = 'typesafe-ai/jev';
// The SDK protocol endpoint differs from Gateway's public REST /v1/evaluate.
const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
export const EVALUATION_URL = `${GATEWAY_BASE_URL}/evaluation-model`;

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

/**
 * Rejects anything that is not a well-formed Choice answer over exactly the asked options.
 * The SDK marks `probabilities` optional; without them there is nothing to gate on, so fail closed.
 */
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
  const confidence = isProbability(raw.confidence) ? raw.confidence : choiceConfidence(probabilities);
  return { choice: raw.choice, probabilities, confidence };
}

function abortError(): DOMException {
  return new DOMException('Jev evaluation cancelled', 'AbortError');
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface GatewayJevClientOptions {
  apiKey: string;
  /** Total deadline per batch, including the one permitted retry. */
  timeoutMs?: number;
  zeroDataRetention?: boolean;
  log?: Log;
}

export interface GatewayJevClientDependencies {
  /** Test transport injection; the destination remains fixed to AI Gateway. */
  fetch?: typeof globalThis.fetch;
  random?: () => number;
}

/** Jev `typesafe-ai/jev` via Vercel AI Gateway only, mirroring the Jevis client. */
export class GatewayJevClient implements JevClient {
  readonly model = JEV_MODEL;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly random: () => number;

  constructor(
    private readonly options: GatewayJevClientOptions,
    dependencies: GatewayJevClientDependencies = {},
  ) {
    if (!options.apiKey.trim()) throw new Error('AI_GATEWAY_API_KEY is required for Jev');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Jev timeout must be positive');
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.random = dependencies.random ?? Math.random;
  }

  async decide(state: JevInput, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<DecideResult> {
    let status: number | undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Jev evaluation timed out', 'TimeoutError'));
    }, this.timeoutMs);

    const gateway = createGateway({
      apiKey: this.options.apiKey.trim(),
      baseURL: GATEWAY_BASE_URL,
      fetch: async (url, init) => {
        // Disallow alternate destinations and redirects even if upstream SDK behavior changes.
        if (String(url) !== EVALUATION_URL) throw new Error('Unexpected Gateway endpoint');
        const response = await this.fetch(url, { ...init, redirect: 'error' });
        status = response.status;
        return response;
      },
    });

    try {
      for (let attempt = 0; ; attempt += 1) {
        status = undefined;
        try {
          const result = await evaluate({
            model: gateway.evaluationModel(JEV_MODEL),
            state,
            questions,
            abortSignal: controller.signal,
            maxRetries: 0,
            providerOptions: {
              gateway: {
                only: ['typesafe-ai'],
                ...(this.options.zeroDataRetention ? { zeroDataRetention: true } : {}),
              },
            },
          });
          const answers = result.answers as unknown;
          if (!isRecord(answers)) throw new JevError('Jev response had no answers map', status);
          const parsed: Record<string, ChoiceAnswer> = {};
          for (const [id, question] of Object.entries(questions)) {
            const answer = parseChoiceAnswer(question, answers[id]);
            if (answer) parsed[id] = answer;
          }
          return { answers: parsed, inputTokens: result.usage.inputTokens };
        } catch (error) {
          if (signal?.aborted) throw abortError();
          if (timedOut) throw new JevError('Jev evaluation timed out');
          if (error instanceof JevError) throw error;
          // Use the observed HTTP status: SDK-wrapped parser/network errors can look like 500s.
          const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
          if (attempt === 0 && retryable) {
            const delayMs = 100 + Math.floor(this.random() * 150);
            this.options.log?.('jev_retry', { status, delayMs });
            await abortableDelay(delayMs, controller.signal);
            continue;
          }
          // Never surface SDK error text: it may embed authorization headers or bookmark payloads.
          throw new JevError(
            status === undefined ? 'Jev network error' : status >= 200 && status < 300 ? 'Jev malformed answers' : `Jev gateway HTTP ${status}`,
            status,
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
