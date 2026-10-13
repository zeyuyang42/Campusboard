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
import { JobRunner, type ImportRequest } from "./services/jobRunner.js";
import { getFreshStreamUrl, refreshAlbum } from "./services/streamService.js";
import { vacuumOrphans } from "./services/importService.js";
import { prunePageCache } from "./services/pageCache.js";
import type { PlayState, SearchResult } from "./types.js";

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
  };
}

export type Core = ReturnType<typeof createCore>;
