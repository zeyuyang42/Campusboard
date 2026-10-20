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

/** tags_json as strings; malformed JSON or entries read as no tags (as listTags does). */
function parseTags(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function rowToAlbum(r: AlbumRow): Album {
  return { ...r, tags: parseTags(r.tags_json), is_preorder: !!r.is_preorder, owned: !!r.owned, wishlisted: !!r.wishlisted };
}

const WISHLISTED = "EXISTS (SELECT 1 FROM fan_items f WHERE f.list = 'wishlist' AND f.item_type = al.item_type AND f.bandcamp_id = al.bandcamp_id)";

// Per album through ix_tracks_album and ix_plays_track, so only that album's plays are read.
const ALBUM_PLAYS = "FROM plays p JOIN tracks t ON t.id = p.track_id WHERE t.album_id = al.id";

const PLAY_COUNT = `(SELECT COUNT(*) ${ALBUM_PLAYS})`;
const LAST_PLAYED = `(SELECT MAX(p.played_at) ${ALBUM_PLAYS})`;

/** The album's star rating (#73), 0 when unrated. */
const RATING = "COALESCE((SELECT n.rating FROM album_notes n WHERE n.album_id = al.id), 0)";

/** Every album column the UI uses; ends with the FROM/JOIN so callers can add joins and WHERE. */
export const ALBUM_SELECT = `
  SELECT al.*, ar.name AS artist_name, ${WISHLISTED} AS wishlisted,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count,
    ${PLAY_COUNT} AS play_count,
    ${LAST_PLAYED} AS last_played_at,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.local_path IS NOT NULL) AS downloaded_count,
    ${RATING} AS rating
  FROM albums al JOIN artists ar ON ar.id = al.artist_id`;

export type AlbumFilter = "all" | "purchased" | "wishlist" | "downloaded" | "rated";
/** Albums with at least one offline copy (#2). */
const DOWNLOADED = "EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.local_path IS NOT NULL)";
const FILTERS: Record<AlbumFilter, string | null> = { all: null, purchased: "al.owned = 1", wishlist: WISHLISTED, downloaded: DOWNLOADED, rated: `${RATING} > 0` };

// Bandcamp release dates are stored as sent ("01 Oct 2021 00:00:00 GMT"), which does not
// sort as text. This turns them into YYYY + month position + DD; NULL stays NULL (last in DESC).
// Expects the albums table aliased as `al`.
export const RELEASE_KEY = `(substr(al.release_date, 8, 4) || printf('%02d', instr('JanFebMarAprMayJunJulAugSepOctNovDec', substr(al.release_date, 4, 3))) || substr(al.release_date, 1, 2))`;

/**
 * Library sort orders, in the order the UI offers them. A new order is one entry here plus
 * its ORDER BY in sorts(). "played" and "plays" put never-played albums last, newest first
 * (NULL sorts last in DESC).
 */
export const ALBUM_SORTS = ["added", "played", "plays", "artist", "title", "release", "rating"] as const;
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
  // Highest first; unrated albums last, newest first among equals.
  rating: `${RATING} DESC, al.created_at DESC, al.id DESC`,
});
const SORTS = sorts();
const INLINE_SORTS = sorts(PLAY_COUNT, LAST_PLAYED);

const MATCH = `(al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND (t.title LIKE ? ESCAPE '\\' OR t.track_artist LIKE ? ESCAPE '\\')))`;

/**
 * Albums carrying a tag (#71). Tags stay in albums.tags_json as Bandcamp sends them; json_each
 * over a few thousand short arrays costs about a millisecond, so there is no tag table to keep
 * in step. Matching folds ASCII case only ("Ambient" and "ambient" are one tag; "électronique"
 * and "electronique" are two), like the filter text. Tags compare trimmed, and a malformed
 * tags_json reads as no tags rather than failing the whole query.
 */
const TAGS_OF_AL = "json_each(CASE WHEN json_valid(al.tags_json) THEN al.tags_json ELSE '[]' END)";
const HAS_TAG = `EXISTS (SELECT 1 FROM ${TAGS_OF_AL} j WHERE j.type = 'text' AND trim(j.value) = ? COLLATE NOCASE)`;

/** The WHERE clause (or "") and its parameters for the Show filter, the filter text and a tag. */
function albumWhere(filter: AlbumFilter, q: string, tag = ""): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const f = FILTERS[filter];
  if (f) where.push(f);
  const t = tag.trim();
  if (t) {
    where.push(HAS_TAG);
    params.push(t);
  }
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
 * artists as a substring (case-insensitive for ASCII), combined with `filter` and, when
 * given, one tag. `limit` (a positive integer) keeps only the first albums in sort order;
 * by default all are listed.
 */
export async function listAlbums(db: Db, sort: AlbumSort = "added", filter: AlbumFilter = "all", q = "", tag = "", opts: { limit?: number } = {}): Promise<Album[]> {
  const w = albumWhere(filter, q, tag);
  const limit = opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null;
  const sql = `${ALBUM_SELECT} ${w.sql} ORDER BY ${SORTS[sort] ?? SORTS.added}${limit ? " LIMIT ?" : ""}`;
  return (await db.select<AlbumRow>(sql, limit ? [...w.params, limit] : w.params)).map(rowToAlbum);
}

/**
 * Every track of the albums listAlbums returns for the same arguments: the albums in that
 * order, each album's tracks in track order. Unstreamable tracks are included (the player
 * skips them; a playlist keeps them). No stream URLs are fetched.
 */
export async function listAlbumTracks(db: Db, sort: AlbumSort = "added", filter: AlbumFilter = "all", q = "", tag = ""): Promise<Track[]> {
  const w = albumWhere(filter, q, tag);
  const sql = `
    WITH fa AS (
      SELECT al.id AS album_id, ROW_NUMBER() OVER (ORDER BY ${INLINE_SORTS[sort] ?? INLINE_SORTS.added}) AS ord
      FROM albums al JOIN artists ar ON ar.id = al.artist_id ${w.sql})
    ${TRACK_SELECT} JOIN fa ON fa.album_id = t.album_id
    ORDER BY fa.ord, t.track_num, t.id`;
  return (await db.select<TrackRow>(sql, w.params)).map(rowToTrack);
}

export interface TagCount { tag: string; album_count: number }

/**
 * Every tag in the library with how many albums carry it (under the Show `filter`), most
 * used first, then by name. Spellings that differ only in ASCII case count as one tag, shown
 * in the form that sorts first (the capitalised genre Bandcamp lists before the free tags).
 */
export async function listTags(db: Db, filter: AlbumFilter = "all"): Promise<TagCount[]> {
  const w = albumWhere(filter, "");
  return db.select<TagCount>(
    `SELECT MIN(trim(j.value)) AS tag, COUNT(DISTINCT al.id) AS album_count
     FROM albums al, ${TAGS_OF_AL} j
     ${w.sql ? `${w.sql} AND` : "WHERE"} j.type = 'text' AND trim(j.value) <> ''
     GROUP BY trim(j.value) COLLATE NOCASE
     ORDER BY album_count DESC, tag COLLATE NOCASE`,
    w.params,
  );
}

export async function getAlbum(db: Db, id: number): Promise<Album | null> {
  const r = await db.get<AlbumRow>(`${ALBUM_SELECT} WHERE al.id = ?`, [id]);
  return r ? rowToAlbum(r) : null;
}

export async function getAlbumWithTracks(db: Db, id: number): Promise<AlbumWithTracks | null> {
  const album = await getAlbum(db, id);
  if (!album) return null;
  const tracks = await db.select<Omit<Track, "streamable" | "downloaded"> & { streamable: number; downloaded: number }>(
    `SELECT id, track_id, album_id, title, track_num, duration, track_artist, streamable, lyrics,
       (SELECT COUNT(*) FROM plays p WHERE p.track_id = tracks.id) AS play_count,
       local_path IS NOT NULL AS downloaded
     FROM tracks WHERE album_id = ? ORDER BY track_num, id`,
    [id],
  );
  return {
    ...album,
    tracks: tracks.map((t) => ({ ...t, streamable: !!t.streamable, downloaded: !!t.downloaded, album_title: album.title, artist_name: album.artist_name, art_id: album.art_id, album_url: album.url })),
  };
}

export async function deleteAlbum(db: Db, id: number): Promise<boolean> {
  // A purchased or wishlisted release the user removes stays out on later syncs.
  await dismissAlbum(db, id);
  const r = await db.run("DELETE FROM albums WHERE id = ?", [id]);
  // The foreign key cascades this; also right with foreign keys off (vacuumOrphans catches the rest).
  await db.run("DELETE FROM album_notes WHERE album_id = ?", [id]);
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
