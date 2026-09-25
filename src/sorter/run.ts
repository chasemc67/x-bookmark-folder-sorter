import type { SorterConfig } from '../config.js';
import { JevError } from '../jev/client.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import type { Log } from '../log.js';
import { MAX_LISTABLE_BOOKMARKS, MAX_TWEET_IDS_PER_ADD, type XClient } from '../x/client.js';
import type { BookmarkFolder } from '../x/types.js';
import { planActions, WRITE_KINDS, type ActionKind, type PlannedAction } from './plan.js';
import { buildBatchRequest, buildFolderOptions, trimText, type ClassificationItem } from './questions.js';

export type SorterRunConfig = Pick<
  SorterConfig,
  | 'dryRun'
  | 'minConfidence'
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
  /**
   * Live mode only: whether the add-to-folder write succeeded, failed, hit maxWritesPerRun, or was
   * skipped because the bookmark was found in a folder when membership was re-read before writing.
   */
  write?: 'added' | 'failed' | 'deferred' | 'skipped_now_filed';
}

export interface RunSummary {
  dryRun: boolean;
  jevModel: string;
  folders: number;
  targetFolders: number;
  bookmarksListed: number;
  unfiled: number;
  classified: number;
  counts: Partial<Record<ActionKind, number>>;
  writes: { attempted: number; added: number; failed: number; deferred: number; skippedNowFiled: number };
  jevInputTokens: number;
  actions: ReportedAction[];
  aborted?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** IDs of every post in any folder, excluded folders included. A failed or partial listing throws. */
async function listFiledTweetIds(x: XBookmarksApi, folders: BookmarkFolder[]): Promise<Set<string>> {
  const filed = new Set<string>();
  for (const folder of [...folders].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const tweetId of await x.listFolderPostIds(folder.id)) filed.add(tweetId);
  }
  return filed;
}

export async function runSorter(
  config: SorterRunConfig,
  deps: { x: XBookmarksApi; jev: JevClient; log: Log },
): Promise<RunSummary> {
  const { x, jev, log } = deps;
  const summary: RunSummary = {
    dryRun: config.dryRun,
    jevModel: jev.model,
    folders: 0,
    targetFolders: 0,
    bookmarksListed: 0,
    unfiled: 0,
    classified: 0,
    counts: {},
    writes: { attempted: 0, added: 0, failed: 0, deferred: 0, skippedNowFiled: 0 },
    jevInputTokens: 0,
    actions: [],
  };
  log('run_start', { dryRun: config.dryRun, jevModel: jev.model });

  const folders = await x.listFolders();
  summary.folders = folders.length;
  const options = buildFolderOptions(folders, config.excludedFolders);
  summary.targetFolders = options.length;
  if (options.length === 0) {
    log('run_done', { reason: 'no_target_folders', folders: folders.length });
    return summary;
  }

  const targetFolderIds = new Set(options.map(option => option.folder.id));
  const filed = await listFiledTweetIds(x, folders);

  const bookmarks = await x.listBookmarks(MAX_LISTABLE_BOOKMARKS);
  summary.bookmarksListed = bookmarks.length;
  const bookmarkIds = new Set(bookmarks.map(bookmark => bookmark.id));
  // Only unfiled bookmarks are ever classified. A bookmark in any folder is never read into Jev,
  // planned, or written, so its folder can never change.
  const unfiled = bookmarks.filter(bookmark => !filed.has(bookmark.id));
  summary.unfiled = unfiled.length;
  const items: ClassificationItem[] = unfiled
    .slice(0, config.maxBookmarksPerRun)
    .map(bookmark => ({ bookmark }));
  summary.classified = items.length;

  const answers = new Map<string, ChoiceAnswer | undefined>();
  for (const [batchIndex, batch] of chunk(items, config.jevBatchSize).entries()) {
    if (summary.aborted) break;
    const request = buildBatchRequest(batch, options, config);
    try {
      const result = await jev.decide(request.state, request.questions);
      summary.jevInputTokens += result.inputTokens ?? 0;
      for (const [questionId, tweetId] of Object.entries(request.questionTweetIds)) {
        answers.set(tweetId, result.answers[questionId]);
      }
    } catch (error) {
      const status = error instanceof JevError ? error.status : undefined;
      log('jev_batch_failed', { batchIndex, size: batch.length, status, message: (error as Error).message });
      // Auth and billing failures will not recover within this run.
      if (status === 401 || status === 402 || status === 403) summary.aborted = (error as Error).message;
    }
  }

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

    for (const action of allowed) {
      // Only ever send unfiled posts that are already bookmarked into target folders that already exist.
      if (action.kind !== 'file' || filed.has(action.tweetId) || !bookmarkIds.has(action.tweetId)) {
        throw new Error('Refusing to write: planned action is not an unfiled bookmark from this run');
      }
      if (!targetFolderIds.has(action.targetFolderId!)) {
        throw new Error('Refusing to write: planned action references an unknown or excluded folder');
      }
    }

    // Re-read folder membership right before writing, so a bookmark filed (by hand or by another
    // run) after the first listing is left alone rather than added to a second folder.
    const byFolder = new Map<string, string[]>();
    if (allowed.length > 0) {
      const freshFolders = await x.listFolders();
      const freshFolderIds = new Set(freshFolders.map(folder => folder.id));
      const filedNow = await listFiledTweetIds(x, freshFolders);
      for (const action of allowed) {
        if (filedNow.has(action.tweetId)) {
          action.write = 'skipped_now_filed';
          summary.writes.skippedNowFiled += 1;
          continue;
        }
        const folderId = action.targetFolderId!;
        if (!freshFolderIds.has(folderId)) {
          throw new Error('Refusing to write: target folder no longer exists');
        }
        byFolder.set(folderId, [...(byFolder.get(folderId) ?? []), action.tweetId]);
      }
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
    aborted: summary.aborted,
  });
  return summary;
}
