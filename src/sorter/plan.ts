import type { ChoiceAnswer } from '../jev/types.js';
import { KEEP_UNFILED, SKIP, type ClassificationItem, type FolderOption } from './questions.js';

/**
 * Every planned action is for an unfiled bookmark. Bookmarks already in any folder are never
 * classified or planned, so there is no refile, move, or misfile kind.
 */
export type ActionKind =
  /** Unfiled bookmark -> folder. The only kind that is ever written. */
  | 'file'
  | 'keep_unfiled'
  | 'skip'
  | 'low_confidence'
  | 'no_decision';

export interface PlannedAction {
  tweetId: string;
  kind: ActionKind;
  targetFolderId?: string;
  targetFolderName?: string;
  choice?: string;
  /** Probability Jev assigned to `choice`. */
  probability?: number;
  confidence?: number;
}

export interface PlanOptions {
  minConfidence: number;
}

export const WRITE_KINDS: ReadonlySet<ActionKind> = new Set(['file']);

/** The gate uses the weaker of the chosen option's probability and the distribution's confidence. */
export function gateScore(answer: ChoiceAnswer): number {
  return Math.min(answer.probabilities[answer.choice] ?? 0, answer.confidence);
}

/** `items` must be unfiled bookmarks only; the runner enforces this before and after planning. */
export function planActions(
  items: ClassificationItem[],
  answers: Map<string, ChoiceAnswer | undefined>,
  options: FolderOption[],
  config: PlanOptions,
): PlannedAction[] {
  const byKey = new Map(options.map(option => [option.key, option.folder]));
  return items.map(({ bookmark }) => {
    const base = { tweetId: bookmark.id };
    const answer = answers.get(bookmark.id);
    if (!answer) return { ...base, kind: 'no_decision' };
    const scored = {
      ...base,
      choice: answer.choice,
      probability: answer.probabilities[answer.choice] ?? 0,
      confidence: answer.confidence,
    };
    if (answer.choice === KEEP_UNFILED) return { ...scored, kind: 'keep_unfiled' };
    if (answer.choice === SKIP) return { ...scored, kind: 'skip' };
    const folder = byKey.get(answer.choice);
    if (!folder) return { ...scored, kind: 'no_decision' };
    const target = { ...scored, targetFolderId: folder.id, targetFolderName: folder.name };
    return { ...target, kind: gateScore(answer) >= config.minConfidence ? 'file' : 'low_confidence' };
  });
}
