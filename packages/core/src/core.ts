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
import { RadioService } from "./services/radio.js";
import { OfflineService, type OfflineFiles } from "./services/offline.js";
import { vacuumOrphans } from "./services/importService.js";
import { prunePageCache } from "./services/pageCache.js";
import { ART_FETCH_TIMEOUT_MS, CHALLENGE_SETTING_KEY, RATE_LIMIT_MS } from "./config.js";
import { ChallengeGate, type ChallengeState } from "./scrape/challenge.js";
import { clearAccount, getAccount, setIdentityCookie, setUsername, PRIVATE_SETTING_KEYS } from "./services/account.js";
import { recomputeOwned } from "./db/repos/fanItems.js";
import * as releases from "./db/repos/releases.js";
import { ReleaseChecker, type ReleaseCheckerOptions } from "./services/releaseWatch.js";
import * as importPending from "./db/repos/importPending.js";
import { CollectionRefresher, type CollectionRefreshOptions } from "./services/collectionRefresh.js";
import {
  backupDatabase, exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport,
  type LibraryExport, type LibraryImportOptions,
} from "./services/libraryTransfer.js";
import type { BrowseResult, PlayState, SearchResult } from "./types.js";

export interface CoreDeps {
  db: Db;
  fetch: FetchLike;
  /** Called whenever an import job changes state. */
  onJobsChange?: () => void;
  /** Called when the new-releases checker stored something or its status changed. */
  onReleasesChange?: () => void;
  /** Called when a background check refreshed an album (a pre-order that came out). */
  onLibraryChange?: () => void;
  /** Timing overrides for the new-releases checker (tests). */
  releaseCheck?: Omit<ReleaseCheckerOptions, "onChange">;
  /** Timing overrides for the background collection refresh (tests). */
  collectionRefresh?: Omit<CollectionRefreshOptions, "onChange">;
  /** The offline folder (#2). Without it offline copies are unavailable and nothing is swept. */
  files?: OfflineFiles | null;
}

/** Everything the UI needs, as plain async functions over one database. */
export function createCore(deps: CoreDeps) {
  const { db } = deps;
  const gate = new ChallengeGate({
    load: () => settings.getSetting<ChallengeState>(db, CHALLENGE_SETTING_KEY),
    save: (s) => settings.setSetting(db, CHALLENGE_SETTING_KEY, s),
  }, () => deps.onJobsChange?.());
  const queue = new FetchQueue(deps.fetch, RATE_LIMIT_MS, gate);
  const offline = new OfflineService(db, queue, deps.files ?? null);
  const runner = new JobRunner(db, queue, deps.onJobsChange, offline);
  /** After anything that may have removed tracks: their offline files go too (deletes last). */
  const sweepOffline = () => offline.sweep().catch((e) => { console.error(`[offline] sweep: ${String(e)}`); return 0; });
  const checker = new ReleaseChecker(db, queue, {
    ...deps.releaseCheck, onChange: () => deps.onReleasesChange?.(), onAlbumRefreshed: () => deps.onLibraryChange?.(),
  });
  const radio = new RadioService(db, queue);
  const refresher = new CollectionRefresher(db, gate, runner, { ...deps.collectionRefresh, onChange: () => deps.onJobsChange?.() });
  void prunePageCache(db);
  void vacuumOrphans(db).then(sweepOffline, () => undefined);
  // Cheap, and repairs flags if the app quit between a sync's membership and flag writes.
  void recomputeOwned(db).catch(() => {});

  return {
    db,
    queue,
    // library
    albums: (sort: albums.AlbumSort = "added", filter: albums.AlbumFilter = "all", q = "") => albums.listAlbums(db, sort, filter, q),
    /** All tracks of the albums `albums(sort, filter, q)` lists, in that order (for bulk actions). */
    albumTracks: (sort: albums.AlbumSort = "added", filter: albums.AlbumFilter = "all", q = "") => albums.listAlbumTracks(db, sort, filter, q),
    album: (id: number) => albums.getAlbumWithTracks(db, id),
    deleteAlbum: async (id: number) => {
      const a = await albums.getAlbum(db, id);
      if (a) await runner.cancelDownloads(a.url);
      const r = await albums.deleteAlbum(db, id);
      await sweepOffline();
      return r;
    },
    refreshAlbum: async (id: number) => {
      const a = await albums.getAlbum(db, id);
      if (a) await refreshAlbum(db, queue, id, a.url);
      // A track Bandcamp dropped from the album is gone from the library, and so is its copy.
      if (a) await sweepOffline();
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
    /** Start the background collection refresh (first look a few minutes later). Not started by createCore. */
    startCollectionRefresh: () => refresher.start(),
    stopCollectionRefresh: () => refresher.stop(),
    collectionRefreshStatus: () => refresher.status(),
    setCollectionRefreshEnabled: (on: boolean) => refresher.setEnabled(on),
    /** One refresh look now, with the same checks as the timer's (selftest and browser checks). */
    collectionRefreshTick: () => refresher.tick(),
    jobs: () => jobs.listJobs(db),
    job: (id: number) => jobs.getJob(db, id),
    cancelJob: (id: number) => runner.cancel(id),
    /** When Bandcamp requests resume after a bot challenge (ms timestamp), or null if they aren't on hold. */
    challengeUntil: async (): Promise<number | null> => { await gate.ready(); return gate.until(); },
    // new releases from library artists
    /** Start the background checker (the first check comes a few minutes later). Not started by createCore. */
    startReleaseChecks: () => checker.start(),
    stopReleaseChecks: () => checker.stop(),
    newReleases: () => releases.listNewReleases(db),
    newReleaseCount: () => releases.countNewReleases(db),
    dismissReleases: async (ids: number[]) => { const n = await releases.dismissReleases(db, ids); deps.onReleasesChange?.(); return n; },
    releaseCheckStatus: () => checker.status(),
    setReleaseChecksEnabled: (on: boolean) => checker.setEnabled(on),
    /** Check every unmuted library artist now, one request each through the queue. */
    checkReleasesNow: () => checker.checkNow(),
    /** Check one artist now (used by the selftest). */
    checkArtistReleases: (artistId: number) => checker.checkArtist(artistId),
    artistReleasesMuted: (artistId: number) => releases.isMuted(db, artistId),
    setArtistReleasesMuted: async (artistId: number, muted: boolean) => { await releases.setMuted(db, artistId, muted); deps.onReleasesChange?.(); },
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
    // offline copies (#2)
    /** A URL for the track's offline copy, or null (then the player streams). Never fetches. */
    localTrackUrl: (trackId: number) => offline.localUrl(trackId),
    /** Queue offline copies of an album's tracks (or just `trackIds`) as a download job; null if all are saved. */
    downloadAlbum: (albumId: number, trackIds?: number[]) => runner.enqueueDownload(albumId, trackIds),
    /** Cancel the album's download if one is queued, and remove its offline copies. */
    removeAlbumDownloads: async (albumId: number) => {
      const a = await albums.getAlbum(db, albumId);
      if (a) await runner.cancelDownloads(a.url);
      return offline.removeAlbum(albumId);
    },
    removeTrackDownloads: (trackIds: number[]) => offline.remove(trackIds),
    /** Cancel every download and remove every offline copy. */
    removeAllDownloads: async () => { await runner.cancelDownloads(); return offline.removeAll(); },
    offlineStats: () => offline.stats(),
    /** The size limit in MB, or null for none. */
    setOfflineCap: (capMb: number | null) => offline.setCap(capMb),
    // Bandcamp Radio
    /** The latest radio episodes (bandcamp.com/radio, read at most once a day). */
    radioShows: () => radio.list(),
    /** One episode with its tracklist and each entry's library album id. */
    radioShow: (showId: number) => radio.show(showId),
    /** An episode's audio URL; `force` reads its page again (after a media error). */
    radioStreamUrl: (showId: number, force = false) => radio.streamUrl(showId, force),
    // listening history
    /** Record one counted play (see services/playRule.ts). Returns the row id, or null if the track is gone. */
    recordPlay: (trackId: number, seconds: number) => plays.recordPlay(db, trackId, seconds),
    recentlyPlayed: (limit = 12) => plays.recentlyPlayedAlbums(db, limit),
    mostPlayed: (limit = 12) => plays.mostPlayedAlbums(db, limit),
    playCount: () => plays.countPlays(db),
    /** Forget all plays, and plays an imported library still has waiting (so they don't come back). */
    clearHistory: async () => { await importPending.clearPendingPlays(db); return plays.clearPlays(db); },
    savePlayState: (s: PlayState) => playState.setPlayState(db, s),
    /** Save just the position (the queue as last saved stays). */
    savePlayPosition: (currentTrackId: number | null, positionSec: number, queueIndex: number) => playState.setPlayPosition(db, currentTrackId, positionSec, queueIndex),
    // Bandcamp account (the identity cookie is write-only from the UI's side)
    account: () => getAccount(db),
    setAccountUsername: (username: string) => setUsername(db, username),
    setIdentityCookie: (cookie: string | null) => setIdentityCookie(db, cookie),
    clearAccount: () => clearAccount(db),
    // settings
    // The account, cookie and sync status have their own functions above; the generic path refuses them.
    getSetting: async <T>(key: string) => { refusePrivate(key); return settings.getSetting<T>(db, key); },
    setSetting: async (key: string, value: unknown) => { refusePrivate(key); return settings.setSetting(db, key, value); },
    vacuumOrphans: async () => { await vacuumOrphans(db); await sweepOffline(); },
    // library file and backup
    /** The library as a JSON-ready object (no identity cookie, caches, stream URLs or palettes). */
    exportLibrary: (opts: { history?: boolean; appVersion?: string } = {}) => exportLibrary(db, opts),
    /** Validate a library file's text; { error } is a sentence for the UI. */
    parseLibraryFile: (text: string) => parseLibraryExport(text),
    previewLibraryImport: (data: LibraryExport) => previewLibraryImport(db, data),
    /** Merge a validated library file and queue its missing albums through the job runner. */
    importLibrary: async (data: LibraryExport, opts: LibraryImportOptions = {}) => {
      const r = await importLibrary(db, runner, data, opts);
      deps.onJobsChange?.();
      deps.onReleasesChange?.();
      return r;
    },
    /** Playlist entries, plays and preferences from an imported library still waiting for their albums. */
    pendingImports: () => importPending.countPending(db),
    clearPendingImports: () => importPending.clearPending(db),
    /** A consistent copy of the whole database at `path` (VACUUM INTO; the file must not exist). */
    backupDatabase: (path: string) => backupDatabase(db, path),
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
