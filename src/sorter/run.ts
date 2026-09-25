import type { SorterConfig } from '../config.js';
import { JevError } from '../jev/client.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import type { Log } from '../log.js';
import { MAX_LISTABLE_BOOKMARKS, MAX_TWEET_IDS_PER_ADD, type XClient } from '../x/client.js';
import type { Bookmark } from '../x/types.js';
import { planActions, WRITE_KINDS, type ActionKind, type PlannedAction } from './plan.js';
import { buildBatchRequest, buildFolderOptions, trimText, type ClassificationItem } from './questions.js';

export type SorterRunConfig = Pick<
  SorterConfig,
  | 'dryRun'
  | 'minConfidence'
  | 'misfiledMinConfidence'
  | 'checkMisfiled'
  | 'refileMisfiled'
  | 'maxBookmarksPerRun'
  | 'maxWritesPerRun'
  | 'jevBatchSize'
  | 'maxTextChars'
  | 'folderDescriptions'
  | 'excludedFolders'
>;

export type XBookmarksApi = Pick<XClient, 'listFolders' | 'listFolderPostIds' | 'listBookmarks' | 'addToFolder'>;

export interface ReportedAction extends PlannedAction {
  author?: string;
  preview: string;
  /** Live mode only: whether the add-to-folder write succeeded, failed, or hit MAX_WRITES_PER_RUN. */
  write?: 'added' | 'failed' | 'deferred';
}

export interface RunSummary {
  dryRun: boolean;
  jevProvider: string;
  folders: number;
  targetFolders: number;
  bookmarksListed: number;
  unfiled: number;
  classified: number;
  counts: Partial<Record<ActionKind, number>>;
  writes: { attempted: number; added: number; failed: number; deferred: number };
  jevInputTokens: number;
  jevCostUsd?: number;
  actions: ReportedAction[];
  aborted?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export async function runSorter(
  config: SorterRunConfig,
  deps: { x: XBookmarksApi; jev: JevClient; log: Log },
): Promise<RunSummary> {
  const { x, jev, log } = deps;
  const summary: RunSummary = {
    dryRun: config.dryRun,
    jevProvider: jev.provider,
    folders: 0,
    targetFolders: 0,
    bookmarksListed: 0,
    unfiled: 0,
    classified: 0,
    counts: {},
    writes: { attempted: 0, added: 0, failed: 0, deferred: 0 },
    jevInputTokens: 0,
    actions: [],
  };
  log('run_start', { dryRun: config.dryRun, jevProvider: jev.provider });

  const folders = await x.listFolders();
  summary.folders = folders.length;
  const options = buildFolderOptions(folders, config.excludedFolders);
  summary.targetFolders = options.length;
  if (options.length === 0) {
    log('run_done', { reason: 'no_target_folders', folders: folders.length });
    return summary;
  }

  const folderById = new Map(folders.map(folder => [folder.id, folder]));
  const excludedIds = new Set(folders.filter(folder => !options.some(option => option.folder.id === folder.id)).map(folder => folder.id));
  const membership = new Map<string, string[]>();
  for (const folder of [...folders].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const tweetId of await x.listFolderPostIds(folder.id)) {
      membership.set(tweetId, [...(membership.get(tweetId) ?? []), folder.id]);
    }
  }

  const bookmarks = await x.listBookmarks(MAX_LISTABLE_BOOKMARKS);
  summary.bookmarksListed = bookmarks.length;
  const bookmarkIds = new Set(bookmarks.map(bookmark => bookmark.id));
  const unfiled = bookmarks.filter(bookmark => !membership.has(bookmark.id));
  summary.unfiled = unfiled.length;
  // Bookmarks in excluded folders are left alone entirely.
  const filed = config.checkMisfiled
    ? bookmarks.filter(bookmark => {
      const ids = membership.get(bookmark.id);
      return ids !== undefined && !ids.some(id => excludedIds.has(id));
    })
    : [];

  const toItem = (bookmark: Bookmark) => {
    const currentFolderIds = membership.get(bookmark.id) ?? [];
    return {
      bookmark,
      currentFolderIds,
      currentFolders: currentFolderIds.map(id => folderById.get(id)?.name ?? id),
    };
  };
  const items: (ClassificationItem & { currentFolderIds: string[] })[] = [...unfiled, ...filed]
    .slice(0, config.maxBookmarksPerRun)
    .map(toItem);
  summary.classified = items.length;

  const answers = new Map<string, ChoiceAnswer | undefined>();
  let costUsd = 0;
  let sawCost = false;
  for (const [batchIndex, batch] of chunk(items, config.jevBatchSize).entries()) {
    if (summary.aborted) break;
    const request = buildBatchRequest(batch, options, config);
    try {
      const result = await jev.decide(request.state, request.questions);
      summary.jevInputTokens += result.inputTokens ?? 0;
      if (result.costUsd !== undefined) {
        costUsd += result.costUsd;
        sawCost = true;
      }
      for (const [questionId, tweetId] of Object.entries(request.questionTweetIds)) {
        answers.set(tweetId, result.answers[questionId]);
      }
    } catch (error) {
      const status = error instanceof JevError ? error.status : undefined;
      log('jev_batch_failed', { batchIndex, size: batch.length, status, message: (error as Error).message });
      if (status === 401 || status === 402) summary.aborted = (error as Error).message;
    }
  }
  if (sawCost) summary.jevCostUsd = Number(costUsd.toFixed(6));

  const planned = planActions(items, answers, options, config);
  const itemById = new Map(items.map(item => [item.bookmark.id, item]));
  const reported: ReportedAction[] = planned.map(action => {
    const bookmark = itemById.get(action.tweetId)!.bookmark;
    return {
      ...action,
      author: bookmark.authorUsername ? `@${bookmark.authorUsername}` : undefined,
      preview: trimText(bookmark.text, 80),
    };
  });
  const reportedById = new Map(reported.map(action => [action.tweetId, action]));

  if (!config.dryRun) {
    const writable = reported.filter(action => WRITE_KINDS.has(action.kind));
    const allowed = writable.slice(0, config.maxWritesPerRun);
    for (const action of writable.slice(config.maxWritesPerRun)) action.write = 'deferred';
    summary.writes.deferred = writable.length - allowed.length;

    const byFolder = new Map<string, string[]>();
    for (const action of allowed) {
      const folderId = action.targetFolderId!;
      // Only ever send posts that are already bookmarked into folders that already exist.
      if (!folderById.has(folderId) || !bookmarkIds.has(action.tweetId)) {
        throw new Error('Refusing to write: planned action references an unknown folder or bookmark');
      }
      byFolder.set(folderId, [...(byFolder.get(folderId) ?? []), action.tweetId]);
    }
    for (const [folderId, tweetIds] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const ids of chunk(tweetIds, MAX_TWEET_IDS_PER_ADD)) {
        summary.writes.attempted += ids.length;
        try {
          const result = await x.addToFolder(folderId, ids);
          const added = new Set(result.added);
          for (const id of ids) reportedById.get(id)!.write = added.has(id) ? 'added' : 'failed';
          summary.writes.added += added.size;
          summary.writes.failed += ids.length - added.size;
          for (const failure of result.failed) log('x_add_failed', { folderId, tweetId: failure.tweetId, detail: failure.detail });
        } catch (error) {
          for (const id of ids) reportedById.get(id)!.write = 'failed';
          summary.writes.failed += ids.length;
          log('x_add_failed', { folderId, count: ids.length, message: (error as Error).message });
        }
      }
    }
  }

  for (const action of reported) {
    summary.counts[action.kind] = (summary.counts[action.kind] ?? 0) + 1;
    log(config.dryRun ? 'planned' : 'action', {
      tweetId: action.tweetId,
      kind: action.kind,
      target: action.targetFolderName,
      choice: action.choice,
      probability: action.probability === undefined ? undefined : Number(action.probability.toFixed(3)),
      confidence: action.confidence === undefined ? undefined : Number(action.confidence.toFixed(3)),
      write: action.write,
      author: action.author,
      preview: action.preview,
    });
  }
  summary.actions = reported;
  log('run_done', {
    dryRun: summary.dryRun,
    folders: summary.folders,
    bookmarksListed: summary.bookmarksListed,
    unfiled: summary.unfiled,
    classified: summary.classified,
    counts: summary.counts,
    writes: summary.writes,
    jevInputTokens: summary.jevInputTokens,
    jevCostUsd: summary.jevCostUsd,
    aborted: summary.aborted,
  });
  return summary;
}
