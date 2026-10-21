import type { Db } from "./db/Db.js";
import { FetchQueue, type FetchLike } from "./scrape/http.js";
import { searchBandcamp } from "./scrape/search.js";
import { ScrapeError } from "./scrape/errors.js";
import { parseTralbumPage } from "./scrape/parseTralbum.js";
import * as artists from "./db/repos/artists.js";
import * as albums from "./db/repos/albums.js";
import * as tracks from "./db/repos/tracks.js";
import * as playlists from "./db/repos/playlists.js";
import * as smart from "./db/repos/smartPlaylists.js";
import * as playState from "./db/repos/playState.js";
import * as jobs from "./db/repos/jobs.js";
import * as settings from "./db/repos/settings.js";
import * as palettes from "./db/repos/palettes.js";
import * as plays from "./db/repos/plays.js";
import * as stats from "./db/repos/stats.js";
import * as albumNotes from "./db/repos/albumNotes.js";
import * as resumePositions from "./db/repos/resumePositions.js";
import * as albumRemoval from "./db/repos/albumRemoval.js";
import { artUrl, extractPalette, type ArtPalette } from "./palette/index.js";
import { JobRunner, type ImportRequest, type ImportSelectionRequest } from "./services/jobRunner.js";
import { cachedFetchText } from "./services/pageCache.js";
import { parseMusicPage } from "./scrape/parseMusic.js";
import { normalizeBandcampUrl } from "./scrape/url.js";
import { getFreshStreamUrl, refreshAlbum } from "./services/streamService.js";
import { RadioService } from "./services/radio.js";
import { PreviewService, previewReleaseTracks } from "./services/discover.js";
import { discoverBatch, locationSuggestions, tagSuggestions } from "./scrape/discover.js";
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
import type { BrowseResult, DiscoverLocation, DiscoverPage, DiscoverParams, DiscoverTag, HistoryCursor, PlayState, QueuePreview, ReleasePreview, SearchResult, StatsPeriod } from "./types.js";

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
  const previews = new PreviewService(db, queue);
  const refresher = new CollectionRefresher(db, gate, runner, { ...deps.collectionRefresh, onChange: () => deps.onJobsChange?.() });
  /** The full delete: queued downloads cancelled, rows (notes, plays, resume points with them), then offline files. */
  const deleteAlbumNow = async (id: number) => {
    const a = await albums.getAlbum(db, id);
    if (a) await runner.cancelDownloads(a.url);
    return albums.deleteAlbum(db, id);
  };
  // Removals with Undo (#93) run one after another; each deletes only albums still marked,
  // so an Undo that came first wins. Delete first, unmark last: interrupted, it runs again.
  let finishing: Promise<number> = Promise.resolve(0);
  const finishRemovals = (only?: number[]) => (finishing = finishing.catch(() => 0).then(async () => {
    const marked = await albumRemoval.removingAlbumIds(db);
    const ids = only ? marked.filter((id) => only.includes(id)) : marked;
    for (const id of ids) {
      await deleteAlbumNow(id);
      await albumRemoval.unmarkRemoving(db, [id]);
    }
    // Resume points have no foreign key to their track (#85): the vacuum takes them, then the files go.
    if (ids.length) { await vacuumOrphans(db); await sweepOffline(); }
    return ids.length;
  }));
  void prunePageCache(db);
  // Removals left marked by a quit (or a kill) inside the Undo window are finished now: the
  // note that offered Undo is gone, so the removal stands. Queued before anything else runs.
  void finishRemovals()
    .catch(() => 0)
    .then(() => vacuumOrphans(db))
    .then(sweepOffline, () => undefined);
  // Cheap, and repairs flags if the app quit between a sync's membership and flag writes.
  void recomputeOwned(db).catch(() => {});

  return {
    db,
    queue,
    // library
    /** Library albums; `opts.limit` keeps the first few (the command palette). */
    albums: (sort: albums.AlbumSort = "added", filter: albums.AlbumFilter = "all", q = "", tag = "", opts: { limit?: number } = {}) => albums.listAlbums(db, sort, filter, q, tag, opts),
    /** All tracks of the albums `albums(sort, filter, q, tag)` lists, in that order (for bulk actions). */
    albumTracks: (sort: albums.AlbumSort = "added", filter: albums.AlbumFilter = "all", q = "", tag = "") => albums.listAlbumTracks(db, sort, filter, q, tag),
    /** The library's tags with album counts (#71), most used first. */
    tags: (filter: albums.AlbumFilter = "all") => albums.listTags(db, filter),
    album: (id: number) => albums.getAlbumWithTracks(db, id),
    /** Your note and rating for an album (#73), or null when there are none. */
    albumNote: (id: number) => albumNotes.getAlbumNote(db, id),
    setAlbumRating: (id: number, rating: number) => albumNotes.setAlbumRating(db, id, rating),
    setAlbumNote: (id: number, note: string) => albumNotes.setAlbumNote(db, id, note),
    deleteAlbum: async (id: number) => {
      const r = await deleteAlbumNow(id);
      await sweepOffline();
      return r;
    },
    /**
     * Remove an album with Undo (#93): it is hidden from the Library, tags, search, artists
     * and smart playlists at once, and deleted by finishAlbumRemovals (the UI calls it when
     * the Undo window ends or the window closes; the next start finishes any left). False
     * when there is no such album.
     */
    removeAlbumLater: (id: number) => albumRemoval.markRemoving(db, id),
    /** Undo removeAlbumLater, while its delete has not run. */
    undoRemoveAlbum: (id: number) => albumRemoval.unmarkRemoving(db, [id]),
    /** Delete the albums removed with removeAlbumLater (all, or just `ids`). Returns how many. */
    finishAlbumRemovals: (ids?: number[]) => finishRemovals(ids),
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
      // An album waiting for its delete (#93) reads as not in the library, as everywhere else.
      const rows = await db.select<{ id: number; url: string }>(`SELECT al.id, al.url FROM albums al WHERE ${albumRemoval.NOT_REMOVING}`);
      const byUrl = new Map(rows.map((r) => [r.url, r.id]));
      // Report the canonical address (custom domain if any), not whichever one was typed.
      return { url: `${parsed.origin}/music`, band: parsed.band, items: parsed.items.map((i) => ({ ...i, album_id: byUrl.get(i.url) ?? null })) };
    },
    /**
     * One page of Bandcamp discover (#104) with library status: one POST through the queue,
     * no page cache (the body is the key and stream URLs expire; the UI's query cache keeps it).
     */
    discover: async (params: DiscoverParams, cursor: string | null = null): Promise<DiscoverPage> => {
      const page = await discoverBatch(queue, params, cursor);
      const urls = [...new Set(page.items.map((i) => i.url))];
      const rows = urls.length
        ? await db.select<{ id: number; url: string }>(`SELECT al.id, al.url FROM albums al WHERE al.url IN (${urls.map(() => "?").join(", ")}) AND ${albumRemoval.NOT_REMOVING}`, urls)
        : [];
      const byUrl = new Map(rows.map((r) => [r.url, r.id]));
      return { ...page, items: page.items.map((i) => ({ ...i, album_id: byUrl.get(i.url) ?? null })) };
    },
    /** Bandcamp's tag autocomplete (2+ characters). */
    discoverTags: async (prefix: string): Promise<DiscoverTag[]> => {
      const p = prefix.trim();
      return p.length < 2 ? [] : tagSuggestions(queue, p);
    },
    /** Bandcamp's place search for the location filter (3+ characters). */
    discoverLocations: async (q: string): Promise<DiscoverLocation[]> => {
      const t = q.trim();
      return t.length < 3 ? [] : locationSuggestions(queue, t);
    },
    /** A Discover preview's audio URL; `force` gets a new one (after a media error). */
    previewStreamUrl: (preview: QueuePreview, force = false) => previews.streamUrl(preview, force),
    /**
     * Play a search or Browse result without importing it. A release already in the library
     * comes back as that album (no request); otherwise its page is read once (page cache)
     * and every streamable track becomes a preview entry. Only album and track links.
     */
    previewRelease: async (input: string): Promise<ReleasePreview> => {
      const n = normalizeBandcampUrl(input);
      if (n.kind === "artist") throw new ScrapeError("invalid_url", "Not an album or track link");
      const inLibrary = async (url: string): Promise<ReleasePreview | null> => {
        const row = await db.get<{ id: number }>(`SELECT al.id FROM albums al WHERE al.url = ? AND ${albumRemoval.NOT_REMOVING}`, [url]);
        const a = row ? await albums.getAlbumWithTracks(db, row.id) : null;
        return a ? { album_id: a.id, title: a.title, tracks: a.tracks.filter((t) => t.streamable).map((t) => ({ ...t, album_title: a.title, artist_name: a.artist_name, art_id: a.art_id })), start: 0 } : null;
      };
      const hit = await inLibrary(n.url);
      if (hit) return hit;
      const parsed = parseTralbumPage(await cachedFetchText(db, queue, n.url));
      // The page may name another address (a custom domain) that the library knows.
      if (parsed.url !== n.url) {
        const again = await inLibrary(parsed.url);
        if (again) return again;
      }
      const { tracks, start } = previewReleaseTracks(parsed);
      if (!tracks.length) throw new ScrapeError("not_streamable", `"${parsed.title}" has nothing to stream yet`);
      return { album_id: null, title: parsed.title, tracks, start };
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
    /** `summaries`: also evaluate smart playlists' counts and covers (the Playlists page). */
    playlists: (opts: { summaries?: boolean } = {}) => playlists.listPlaylists(db, opts),
    playlist: (id: number) => playlists.getPlaylist(db, id),
    createPlaylist: (name: string) => playlists.createPlaylist(db, name),
    /** A smart playlist (#84) from a rule (validated with SmartRuleSchema). */
    createSmartPlaylist: (name: string, rule: unknown) => playlists.createSmartPlaylist(db, name, rule),
    setSmartRule: (id: number, rule: unknown) => smart.setSmartRule(db, id, rule),
    /** A smart rule's tracks right now, in order (for Play/Shuffle). */
    smartTracks: (rule: unknown) => smart.evaluateSmartRule(db, smart.requireRule(rule)),
    /** How many tracks a rule matches right now (the editor's live count). */
    smartCount: async (rule: unknown) => (await smart.summarizeSmartRule(db, smart.requireRule(rule))).track_count,
    renamePlaylist: (id: number, name: string) => playlists.renamePlaylist(db, id, name),
    deletePlaylist: (id: number) => playlists.deletePlaylist(db, id),
    addToPlaylist: (id: number, trackIds: number[]) => playlists.addTracks(db, id, trackIds),
    reorderPlaylist: (id: number, playlistTrackIds: number[]) => playlists.reorder(db, id, playlistTrackIds),
    removeFromPlaylist: (id: number, playlistTrackId: number) => playlists.removeTrack(db, id, playlistTrackId),
    /** Remove entries and get what restorePlaylistTracks needs to put them back (#93), or null. */
    removeFromPlaylistWithUndo: (id: number, playlistTrackIds: number[]) => playlists.removeTracksWithUndo(db, id, playlistTrackIds),
    restorePlaylistTracks: (snap: playlists.RemovedPlaylistTracks) => playlists.restoreTracks(db, snap),
    /** Delete a playlist and get what restorePlaylist needs (#93), or null when there was none. */
    deletePlaylistWithUndo: (id: number) => playlists.deletePlaylistWithUndo(db, id),
    /** Recreate a deleted playlist (its old id when free); returns its id. */
    restorePlaylist: (snap: playlists.DeletedPlaylist) => playlists.restorePlaylist(db, snap),
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
    /** Which of these tracks have an offline copy (by the rows; one query, no file checks). */
    downloadedTrackIds: async (trackIds: number[]): Promise<number[]> => {
      const ids = trackIds.filter((id) => id > 0).slice(0, 10_000);
      const out: number[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        out.push(...(await db.select<{ id: number }>(`SELECT id FROM tracks WHERE local_path IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`, chunk)).map((r) => r.id));
      }
      return out;
    },
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
    /** One page of the History view (#86), newest first; pass the previous page's `next`. */
    history: (before: HistoryCursor | null = null, limit = 50) => plays.listPlays(db, before, limit),
    /** Listening stats (#94): the top 10 artists, albums and tags and the totals for this month, this year or all time. */
    listeningStats: (period: StatsPeriod) => stats.listeningStats(db, period),
    /** Forget all plays, and plays an imported library still has waiting (so they don't come back). */
    clearHistory: async () => { await importPending.clearPendingPlays(db); return plays.clearPlays(db); },
    savePlayState: (s: PlayState) => playState.setPlayState(db, s),
    /** Save just the position (the queue as last saved stays). */
    savePlayPosition: (currentTrackId: number | null, positionSec: number, queueIndex: number) => playState.setPlayPosition(db, currentTrackId, positionSec, queueIndex),
    // resume points (#85), keyed by the queue entry's id (negative for a Radio episode)
    resumePosition: (itemId: number) => resumePositions.getResumePosition(db, itemId),
    saveResumePosition: (itemId: number, positionSec: number) => resumePositions.setResumePosition(db, itemId, positionSec),
    clearResumePosition: (itemId: number) => resumePositions.clearResumePosition(db, itemId),
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
  if (PRIVATE_SETTING_KEYS.has(key)) throw new Error(`Setting "${key}" is only available through its own functions`);
}

export type Core = ReturnType<typeof createCore>;
