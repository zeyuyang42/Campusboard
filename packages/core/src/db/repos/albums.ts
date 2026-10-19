import type { Db } from "../Db.js";
import { likeContains } from "../Db.js";
import { dismissAlbum } from "./fanItems.js";
import { TRACK_SELECT, rowToTrack, type TrackRow } from "./tracks.js";
import type { Album, AlbumWithTracks, Track } from "../../types.js";
import { preorderRecheckDue, releaseTime } from "../../services/preorder.js";

export interface AlbumRow extends Omit<Album, "tags" | "is_preorder" | "owned" | "wishlisted"> {
  tags_json: string;
  is_preorder: number;
  owned: number;
  wishlisted: number;
}

export function rowToAlbum(r: AlbumRow): Album {
  return { ...r, tags: JSON.parse(r.tags_json || "[]"), is_preorder: !!r.is_preorder, owned: !!r.owned, wishlisted: !!r.wishlisted };
}

const WISHLISTED = "EXISTS (SELECT 1 FROM fan_items f WHERE f.list = 'wishlist' AND f.item_type = al.item_type AND f.bandcamp_id = al.bandcamp_id)";

// Per album through ix_tracks_album and ix_plays_track, so only that album's plays are read.
const ALBUM_PLAYS = "FROM plays p JOIN tracks t ON t.id = p.track_id WHERE t.album_id = al.id";

const PLAY_COUNT = `(SELECT COUNT(*) ${ALBUM_PLAYS})`;
const LAST_PLAYED = `(SELECT MAX(p.played_at) ${ALBUM_PLAYS})`;

/** Every album column the UI uses; ends with the FROM/JOIN so callers can add joins and WHERE. */
export const ALBUM_SELECT = `
  SELECT al.*, ar.name AS artist_name, ${WISHLISTED} AS wishlisted,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count,
    ${PLAY_COUNT} AS play_count,
    ${LAST_PLAYED} AS last_played_at
  FROM albums al JOIN artists ar ON ar.id = al.artist_id`;

export type AlbumFilter = "all" | "purchased" | "wishlist";
const FILTERS: Record<AlbumFilter, string | null> = { all: null, purchased: "al.owned = 1", wishlist: WISHLISTED };

// Bandcamp release dates are stored as sent ("01 Oct 2021 00:00:00 GMT"), which does not
// sort as text. This turns them into YYYY + month position + DD; NULL stays NULL (last in DESC).
// Expects the albums table aliased as `al`.
export const RELEASE_KEY = `(substr(al.release_date, 8, 4) || printf('%02d', instr('JanFebMarAprMayJunJulAugSepOctNovDec', substr(al.release_date, 4, 3))) || substr(al.release_date, 1, 2))`;

/**
 * Library sort orders, in the order the UI offers them. A new order is one entry here plus
 * its ORDER BY in sorts(). "played" and "plays" put never-played albums last, newest first
 * (NULL sorts last in DESC).
 */
export const ALBUM_SORTS = ["added", "played", "plays", "artist", "title", "release"] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];

/**
 * ORDER BY per sort. `plays` and `last` name the album's play count and latest play: the
 * ALBUM_SELECT aliases by default, or the expressions themselves where those aliases aren't
 * visible (a window's ORDER BY).
 */
const sorts = (plays = "play_count", last = "last_played_at"): Record<AlbumSort, string> => ({
  added: "al.created_at DESC, al.id DESC",
  played: `${last} DESC, al.created_at DESC, al.id DESC`,
  plays: `${plays} DESC, ${last} DESC, al.created_at DESC, al.id DESC`,
  artist: `ar.name COLLATE NOCASE, ${RELEASE_KEY} DESC, al.id DESC`,
  title: "al.title COLLATE NOCASE, ar.name COLLATE NOCASE, al.id",
  release: `${RELEASE_KEY} DESC, al.title COLLATE NOCASE, al.id`,
});
const SORTS = sorts();
const INLINE_SORTS = sorts(PLAY_COUNT, LAST_PLAYED);

const MATCH = `(al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND (t.title LIKE ? ESCAPE '\\' OR t.track_artist LIKE ? ESCAPE '\\')))`;

/** The WHERE clause (or "") and its parameters for the Show filter plus the filter text. */
function albumWhere(filter: AlbumFilter, q: string): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const f = FILTERS[filter];
  if (f) where.push(f);
  const term = q.trim();
  if (term) {
    const like = likeContains(term);
    where.push(MATCH);
    params.push(like, like, like, like);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * The library's albums. `q` matches album title, artist name, track titles and track
 * artists as a substring (case-insensitive for ASCII), combined with `filter`.
 */
export async function listAlbums(db: Db, sort: AlbumSort = "added", filter: AlbumFilter = "all", q = ""): Promise<Album[]> {
  const w = albumWhere(filter, q);
  const sql = `${ALBUM_SELECT} ${w.sql} ORDER BY ${SORTS[sort] ?? SORTS.added}`;
  return (await db.select<AlbumRow>(sql, w.params)).map(rowToAlbum);
}

/**
 * Every track of the albums listAlbums returns for the same arguments: the albums in that
 * order, each album's tracks in track order. Unstreamable tracks are included (the player
 * skips them; a playlist keeps them). No stream URLs are fetched.
 */
export async function listAlbumTracks(db: Db, sort: AlbumSort = "added", filter: AlbumFilter = "all", q = ""): Promise<Track[]> {
  const w = albumWhere(filter, q);
  const sql = `
    WITH fa AS (
      SELECT al.id AS album_id, ROW_NUMBER() OVER (ORDER BY ${INLINE_SORTS[sort] ?? INLINE_SORTS.added}) AS ord
      FROM albums al JOIN artists ar ON ar.id = al.artist_id ${w.sql})
    ${TRACK_SELECT} JOIN fa ON fa.album_id = t.album_id
    ORDER BY fa.ord, t.track_num, t.id`;
  return (await db.select<TrackRow>(sql, w.params)).map(rowToTrack);
}

export async function getAlbum(db: Db, id: number): Promise<Album | null> {
  const r = await db.get<AlbumRow>(`${ALBUM_SELECT} WHERE al.id = ?`, [id]);
  return r ? rowToAlbum(r) : null;
}

export async function getAlbumWithTracks(db: Db, id: number): Promise<AlbumWithTracks | null> {
  const album = await getAlbum(db, id);
  if (!album) return null;
  const tracks = await db.select<Omit<Track, "streamable"> & { streamable: number }>(
    `SELECT id, track_id, album_id, title, track_num, duration, track_artist, streamable, lyrics,
       (SELECT COUNT(*) FROM plays p WHERE p.track_id = tracks.id) AS play_count
     FROM tracks WHERE album_id = ? ORDER BY track_num, id`,
    [id],
  );
  return {
    ...album,
    tracks: tracks.map((t) => ({ ...t, streamable: !!t.streamable, album_title: album.title, artist_name: album.artist_name, art_id: album.art_id, album_url: album.url })),
  };
}

export async function deleteAlbum(db: Db, id: number): Promise<boolean> {
  // A purchased or wishlisted release the user removes stays out on later syncs.
  await dismissAlbum(db, id);
  const r = await db.run("DELETE FROM albums WHERE id = ?", [id]);
  await db.run("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
  return r.changes > 0;
}

export async function albumUrlsInLibrary(db: Db): Promise<Set<string>> {
  return new Set((await db.select<{ url: string }>("SELECT url FROM albums")).map((r) => r.url));
}

export async function artistUrlsInLibrary(db: Db): Promise<Set<string>> {
  return new Set((await db.select<{ url: string }>("SELECT url FROM artists")).map((r) => r.url));
}

export interface PreorderAlbum { id: number; url: string; title: string; release_date: string | null; fetched_at: string }

/**
 * The first pre-order album due for its after-release re-fetch (services/preorder.ts), oldest
 * release first. Pre-orders are few, so the date logic runs here rather than in SQL (release
 * dates are stored as Bandcamp sends them). `skip` holds ids to pass over (recent failures).
 */
export async function nextDuePreorder(db: Db, now: number, skip: ReadonlySet<number> = new Set()): Promise<PreorderAlbum | null> {
  const rows = await db.select<PreorderAlbum>("SELECT id, url, title, release_date, fetched_at FROM albums WHERE is_preorder = 1");
  const due = rows
    .filter((r) => !skip.has(r.id) && preorderRecheckDue({ is_preorder: true, release_date: r.release_date, fetched_at: r.fetched_at }, now))
    .sort((a, b) => (releaseTime(a.release_date) ?? 0) - (releaseTime(b.release_date) ?? 0) || a.id - b.id);
  return due[0] ?? null;
}
