import type { QueryClient } from "@tanstack/react-query";

/**
 * Named groups of query-key prefixes (see `keys` in queries.ts) that one kind of change
 * touches. Hooks pass the React client; code outside React (core's callbacks) uses the one
 * bound at boot. Kept apart from core.ts and queries.ts so both can import it without a cycle.
 */
export const KEY_GROUPS = {
  /** Everything an import, a removal or an edit may have changed. */
  library: ["albums", "album", "artists", "artist", "tracks", "search", "playlists", "playlist", "history", "releases", "crates"],
  /** A pre-order that came out, or tracks that changed: nothing imported, so no artists, search or releases. */
  libraryTracks: ["albums", "album", "artist", "tracks", "playlist", "history"],
  /** Listening history cleared: everything that shows play counts. */
  history: ["history", "albums", "album", "tracks", "playlist"],
  /** Offline copies (#2): the Storage totals, the tracks' saved marks and the download jobs. */
  offline: ["offline", "albums", "album", "tracks", "playlist", "jobs"],
  /**
   * A job update: the job lists; the account summary and Purchased/Wishlist flags (a collection
   * sync); the New releases list (an import may take a release off it, and a job pauses the
   * checker); an imported library's playlists and history, which fill in as its albums arrive;
   * and the album pages and Storage totals a download job marks track by track.
   */
  jobs: ["jobs", "job", "account", "releases", "playlists", "playlist", "history", "album", "offline"],
} as const satisfies Record<string, readonly string[]>;

export type KeyGroup = keyof typeof KEY_GROUPS;

let bound: QueryClient | null = null;

/** Called once at boot so code outside React can invalidate queries. */
export function bindQueryClient(client: QueryClient) {
  bound = client;
}

/** Refetch every query whose key starts with one of `prefixes` (for code outside React). */
export function invalidateQueries(prefixes: readonly string[], client: QueryClient | null = bound) {
  for (const k of prefixes) void client?.invalidateQueries({ queryKey: [k] });
}

/** Refetch the queries a named group covers; `client` defaults to the one bound at boot. */
export function invalidateGroup(name: KeyGroup, client: QueryClient | null = bound) {
  invalidateQueries(KEY_GROUPS[name], client);
}
