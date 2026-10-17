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
import { artUrl, extractPalette, type ArtPalette } from "./palette/index.js";
import { JobRunner, type ImportRequest, type ImportSelectionRequest } from "./services/jobRunner.js";
import { cachedFetchText } from "./services/pageCache.js";
import { parseMusicPage } from "./scrape/parseMusic.js";
import { normalizeBandcampUrl } from "./scrape/url.js";
import { getFreshStreamUrl, refreshAlbum } from "./services/streamService.js";
import { vacuumOrphans } from "./services/importService.js";
import { prunePageCache } from "./services/pageCache.js";
import { ART_FETCH_TIMEOUT_MS } from "./config.js";
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
  const queue = new FetchQueue(deps.fetch);
  const runner = new JobRunner(db, queue, deps.onJobsChange);
  void prunePageCache(db);
  void vacuumOrphans(db);

  return {
    db,
    queue,
    // library
    albums: (sort: albums.AlbumSort = "added") => albums.listAlbums(db, sort),
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
    jobs: () => jobs.listJobs(db),
    job: (id: number) => jobs.getJob(db, id),
    cancelJob: (id: number) => runner.cancel(id),
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
    savePlayState: (s: PlayState) => playState.setPlayState(db, s),
    // settings
    getSetting: <T>(key: string) => settings.getSetting<T>(db, key),
    setSetting: (key: string, value: unknown) => settings.setSetting(db, key, value),
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

export type Core = ReturnType<typeof createCore>;
