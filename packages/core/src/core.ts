import type { Db } from "./db/Db.js";
import { FetchQueue, type FetchLike } from "./scrape/http.js";
import { searchBandcamp } from "./scrape/search.js";
import * as artists from "./db/repos/artists.js";
import * as albums from "./db/repos/albums.js";
import * as tracks from "./db/repos/tracks.js";
import * as playlists from "./db/repos/playlists.js";
import * as playState from "./db/repos/playState.js";
import * as jobs from "./db/repos/jobs.js";
import * as settings from "./db/repos/settings.js";
import * as palettes from "./db/repos/palettes.js";
import * as plays from "./db/repos/plays.js";
import { artUrl, extractPalette, type ArtPalette } from "./palette/index.js";
import { JobRunner, type ImportRequest, type ImportSelectionRequest } from "./services/jobRunner.js";
import { cachedFetchText } from "./services/pageCache.js";
import { parseMusicPage } from "./scrape/parseMusic.js";
import { normalizeBandcampUrl } from "./scrape/url.js";
import { getFreshStreamUrl, refreshAlbum } from "./services/streamService.js";
import { vacuumOrphans } from "./services/importService.js";
import { prunePageCache } from "./services/pageCache.js";
import { ART_FETCH_TIMEOUT_MS, CHALLENGE_SETTING_KEY, RATE_LIMIT_MS } from "./config.js";
import { ChallengeGate, type ChallengeState } from "./scrape/challenge.js";
import { clearAccount, getAccount, setIdentityCookie, setUsername, PRIVATE_SETTING_KEYS } from "./services/account.js";
import { recomputeOwned } from "./db/repos/fanItems.js";
import type { BrowseResult, PlayState, SearchResult } from "./types.js";

export interface CoreDeps {
  db: Db;
  fetch: FetchLike;
  /** Called whenever an import job changes state. */
  onJobsChange?: () => void;
}

/** Everything the UI needs, as plain async functions over one database. */
export function createCore(deps: CoreDeps) {
  const { db } = deps;
  const gate = new ChallengeGate({
    load: () => settings.getSetting<ChallengeState>(db, CHALLENGE_SETTING_KEY),
    save: (s) => settings.setSetting(db, CHALLENGE_SETTING_KEY, s),
  }, () => deps.onJobsChange?.());
  const queue = new FetchQueue(deps.fetch, RATE_LIMIT_MS, gate);
  const runner = new JobRunner(db, queue, deps.onJobsChange);
  void prunePageCache(db);
  void vacuumOrphans(db);
  // Cheap, and repairs flags if the app quit between a sync's membership and flag writes.
  void recomputeOwned(db).catch(() => {});

  return {
    db,
    queue,
    // library
    albums: (sort: albums.AlbumSort = "added", filter: albums.AlbumFilter = "all", q = "") => albums.listAlbums(db, sort, filter, q),
    album: (id: number) => albums.getAlbumWithTracks(db, id),
    deleteAlbum: (id: number) => albums.deleteAlbum(db, id),
    refreshAlbum: async (id: number) => {
      const a = await albums.getAlbum(db, id);
      if (a) await refreshAlbum(db, queue, id, a.url);
      return albums.getAlbumWithTracks(db, id);
    },
    artists: () => artists.listArtists(db),
    artist: (id: number) => artists.getArtist(db, id),
    tracks: (q: string) => tracks.searchTracks(db, q),
    tracksByIds: (ids: number[]) => tracks.getTracksByIds(db, ids),
    // imports
    import: (req: ImportRequest) => runner.enqueue(req),
    importSelection: (req: ImportSelectionRequest) => runner.enqueueSelection(req),
    /** List an artist's or label's releases with library status, without importing anything. */
    browse: async (input: string): Promise<BrowseResult> => {
      const n = normalizeBandcampUrl(input);
      const url = n.kind === "artist" ? n.url : `https://${n.host}/music`;
      const parsed = parseMusicPage(await cachedFetchText(db, queue, url), `https://${n.host}`);
      const rows = await db.select<{ id: number; url: string }>("SELECT id, url FROM albums");
      const byUrl = new Map(rows.map((r) => [r.url, r.id]));
      // Report the canonical address (custom domain if any), not whichever one was typed.
      return { url: `${parsed.origin}/music`, band: parsed.band, items: parsed.items.map((i) => ({ ...i, album_id: byUrl.get(i.url) ?? null })) };
    },
    /** Sync the purchased collection and wishlist of the Bandcamp account in Settings. */
    syncCollection: () => runner.enqueueSync(),
    jobs: () => jobs.listJobs(db),
    job: (id: number) => jobs.getJob(db, id),
    cancelJob: (id: number) => runner.cancel(id),
    /** When Bandcamp requests resume after a bot challenge (ms timestamp), or null if they aren't on hold. */
    challengeUntil: async (): Promise<number | null> => { await gate.ready(); return gate.until(); },
    // playlists
    playlists: () => playlists.listPlaylists(db),
    playlist: (id: number) => playlists.getPlaylist(db, id),
    createPlaylist: (name: string) => playlists.createPlaylist(db, name),
    renamePlaylist: (id: number, name: string) => playlists.renamePlaylist(db, id, name),
    deletePlaylist: (id: number) => playlists.deletePlaylist(db, id),
    addToPlaylist: (id: number, trackIds: number[]) => playlists.addTracks(db, id, trackIds),
    reorderPlaylist: (id: number, playlistTrackIds: number[]) => playlists.reorder(db, id, playlistTrackIds),
    removeFromPlaylist: (id: number, playlistTrackId: number) => playlists.removeTrack(db, id, playlistTrackId),
    playlistsContaining: (trackIds: number[]) => playlists.playlistsContaining(db, trackIds),
    // search
    search: async (q: string): Promise<SearchResult[]> => {
      if (q.trim().length < 2) return [];
      const [raw, albumUrls, artistUrls] = await Promise.all([searchBandcamp(queue, q), albums.albumUrlsInLibrary(db), albums.artistUrlsInLibrary(db)]);
      return raw.map((r) => ({ ...r, in_library: r.type === "band" ? artistUrls.has(r.url) : albumUrls.has(r.url) }));
    },
    // playback
    getFreshStreamUrl: (trackId: number, force = false) => getFreshStreamUrl(db, queue, trackId, force),
    playState: () => playState.getPlayState(db),
    // listening history
    /** Record one counted play (see services/playRule.ts). Returns the row id, or null if the track is gone. */
    recordPlay: (trackId: number, seconds: number) => plays.recordPlay(db, trackId, seconds),
    recentlyPlayed: (limit = 12) => plays.recentlyPlayedAlbums(db, limit),
    mostPlayed: (limit = 12) => plays.mostPlayedAlbums(db, limit),
    playCount: () => plays.countPlays(db),
    clearHistory: () => plays.clearPlays(db),
    savePlayState: (s: PlayState) => playState.setPlayState(db, s),
    // Bandcamp account (the identity cookie is write-only from the UI's side)
    account: () => getAccount(db),
    setAccountUsername: (username: string) => setUsername(db, username),
    setIdentityCookie: (cookie: string | null) => setIdentityCookie(db, cookie),
    clearAccount: () => clearAccount(db),
    // settings
    // The account, cookie and sync status have their own functions above; the generic path refuses them.
    getSetting: async <T>(key: string) => { refusePrivate(key); return settings.getSetting<T>(db, key); },
    setSetting: async (key: string, value: unknown) => { refusePrivate(key); return settings.setSetting(db, key, value); },
    vacuumOrphans: () => vacuumOrphans(db),
    /** Raw colors for a piece of art, cached per art id. Fetched directly (not through the import queue). */
    getArtPalette: async (artId: number): Promise<ArtPalette | null> => {
      const cached = await palettes.getCachedPalette(db, artId);
      if (cached) return cached;
      const url = artUrl(artId, 2);
      if (!url) return null;
      // Bypasses FetchQueue on purpose (static CDN), so it needs its own timeout.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ART_FETCH_TIMEOUT_MS);
      let bytes: ArrayBuffer;
      try {
        const res = await deps.fetch(url, { headers: { Accept: "image/*" }, signal: ctrl.signal });
        if (!res.ok) return null;
        bytes = await res.arrayBuffer();
      } catch {
        return null; // timed out or network error: no palette, the UI keeps its defaults
      } finally {
        clearTimeout(timer);
      }
      const p = await extractPalette(bytes);
      await palettes.cachePalette(db, artId, p);
      return p;
    },
  };
}

function refusePrivate(key: string): void {
  if (PRIVATE_SETTING_KEYS.has(key)) throw new Error(`Setting "${key}" is only available through the account functions`);
}

export type Core = ReturnType<typeof createCore>;
