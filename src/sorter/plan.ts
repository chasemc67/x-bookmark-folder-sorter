import type { ChoiceAnswer } from '../jev/types.js';
import { KEEP_UNFILED, SKIP, type ClassificationItem, type FolderOption } from './questions.js';

export type ActionKind =
  /** Unfiled bookmark -> folder. Written in live mode. */
  | 'file'
  /** Filed bookmark -> a different folder. Written in live mode only when REFILE_MISFILED=true. */
  | 'refile'
  /** Filed bookmark that looks misfiled; reported, never written. */
  | 'misfiled_report'
  /** Already in the chosen folder: idempotent no-op. */
  | 'already_in_folder'
  | 'keep_unfiled'
  | 'skip'
  | 'low_confidence'
  | 'no_decision';

export interface PlannedAction {
  tweetId: string;
  kind: ActionKind;
  currentFolderIds: string[];
  targetFolderId?: string;
  targetFolderName?: string;
  choice?: string;
  /** Probability Jev assigned to `choice`. */
  probability?: number;
  confidence?: number;
}

export interface PlanOptions {
  minConfidence: number;
  misfiledMinConfidence: number;
  refileMisfiled: boolean;
}

export const WRITE_KINDS: ReadonlySet<ActionKind> = new Set(['file', 'refile']);

/** The gate uses the weaker of the chosen option's probability and the distribution's confidence. */
export function gateScore(answer: ChoiceAnswer): number {
  return Math.min(answer.probabilities[answer.choice] ?? 0, answer.confidence);
}

export function planActions(
  items: (ClassificationItem & { currentFolderIds: string[] })[],
  answers: Map<string, ChoiceAnswer | undefined>,
  options: FolderOption[],
  config: PlanOptions,
): PlannedAction[] {
  const byKey = new Map(options.map(option => [option.key, option.folder]));
  return items.map(({ bookmark, currentFolderIds }) => {
    const base = { tweetId: bookmark.id, currentFolderIds };
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
    if (currentFolderIds.includes(folder.id)) return { ...target, kind: 'already_in_folder' };
    const score = gateScore(answer);
    if (currentFolderIds.length === 0) {
      return { ...target, kind: score >= config.minConfidence ? 'file' : 'low_confidence' };
    }
    if (score < config.misfiledMinConfidence) return { ...target, kind: 'low_confidence' };
    return { ...target, kind: config.refileMisfiled ? 'refile' : 'misfiled_report' };
  });
}
