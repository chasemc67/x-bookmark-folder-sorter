export interface BookmarkFolder {
  id: string;
  name: string;
}

export interface Bookmark {
  id: string;
  text: string;
  authorId?: string;
  authorUsername?: string;
}

export interface AddToFolderResult {
  folderId: string;
  added: string[];
  failed: { tweetId: string; detail: string }[];
}

/** Access tokens are resolved per request so long runs survive a refresh. */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}
