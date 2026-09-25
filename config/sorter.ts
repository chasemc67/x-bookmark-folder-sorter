/**
 * Checked-in tunables for the sorter. Edit here and deploy; none of these are env vars.
 * Only credentials live in env (see .env.example); X OAuth credentials live in Vercel Connect.
 * Values are validated at startup.
 */
export interface SorterSettings {
  /** true: log planned folder assignments only. false: add bookmarks to folders (never deletes). */
  dryRun: boolean;
  /** Numeric X user id. Leave empty to look it up via GET /2/users/me each run. */
  xUserId: string;

  /** Minimum Jev probability AND confidence required to file an unfiled bookmark. */
  minConfidence: number;
  /** Re-classify bookmarks already in a folder and report likely misfiles. */
  checkMisfiled: boolean;
  /** Actually add misfiled bookmarks to the better folder (live mode only). Report-only when false. */
  refileMisfiled: boolean;
  /** Stricter gate for misfile reports and refiles. */
  misfiledMinConfidence: number;

  /** Cap on Jev classifications per run (X lists at most the 800 most recent bookmarks). */
  maxBookmarksPerRun: number;
  /** Cap on add-to-folder writes per run; the rest wait for the next run. */
  maxWritesPerRun: number;

  /** Bookmarks per Jev request (one shared state, one Choice question each). */
  jevBatchSize: number;
  /** Post text is trimmed to this many characters before it goes into the Jev state. */
  maxTextChars: number;
  /** Total deadline per Jev batch, including the one permitted retry. */
  jevTimeoutMs: number;
  /** Ask Vercel AI Gateway for zero data retention on Jev calls. */
  gatewayZeroDataRetention: boolean;

  /** Folder name (as shown in X) -> what belongs there. Sharpens the Choice criteria. */
  folderDescriptions: Record<string, string>;
  /** Folder names that are never targets; bookmarks already in them are never touched. */
  excludedFolders: string[];

  /** Vercel Connect Custom OAuth connector uid. The X client id/secret live in the connector. */
  xConnectConnector: string;
  /**
   * Vercel Connect `user` subject whose X grant the cron uses. One subject is one authorized
   * X account; a multi-user version would pass each user's own subject id instead.
   */
  xConnectSubjectId: string;
}

export const sorterSettings: SorterSettings = {
  dryRun: true,
  xUserId: '',

  minConfidence: 0.7,
  checkMisfiled: true,
  refileMisfiled: false,
  misfiledMinConfidence: 0.9,

  maxBookmarksPerRun: 200,
  maxWritesPerRun: 50,

  jevBatchSize: 10,
  maxTextChars: 400,
  jevTimeoutMs: 15_000,
  gatewayZeroDataRetention: false,

  folderDescriptions: {
    // 'AI': 'machine learning papers, models, and tooling',
  },
  excludedFolders: [],

  xConnectConnector: 'oauth/x-bookmarks',
  xConnectSubjectId: 'chase',
};
