export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** State, instructions, and criteria may be text or structured JSON, but not a bare scalar. */
export type JevInput = string | { [key: string]: JsonValue } | JsonValue[];

export interface ChoiceQuestion {
  type: 'choice';
  instructions: JevInput;
  /** Option keys and descriptions are both sent to the model. */
  criteria: Record<string, JevInput | null>;
}

export interface ChoiceAnswer {
  choice: string;
  /** Complete distribution over the question's options. */
  probabilities: Record<string, number>;
  /** 0-1 concentration of `probabilities`, computed with TypeSafe's documented formula. */
  confidence: number;
}

export interface DecideResult {
  /** Answers that failed validation are omitted so callers fail closed per question. */
  answers: Record<string, ChoiceAnswer>;
  inputTokens?: number;
}

export interface JevClient {
  readonly model: string;
  decide(state: JevInput, questions: Record<string, ChoiceQuestion>, signal?: AbortSignal): Promise<DecideResult>;
}
