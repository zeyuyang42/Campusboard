import type { Db } from "../Db.js";
import { likeContains } from "../Db.js";
import { dismissAlbum } from "./fanItems.js";
import type { Album, AlbumWithTracks, Track } from "../../types.js";

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

/** Every album column the UI uses; ends with the FROM/JOIN so callers can add joins and WHERE. */
export const ALBUM_SELECT = `
  SELECT al.*, ar.name AS artist_name, ${WISHLISTED} AS wishlisted,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count,
    (SELECT COUNT(*) ${ALBUM_PLAYS}) AS play_count,
    (SELECT MAX(p.played_at) ${ALBUM_PLAYS}) AS last_played_at
  FROM albums al JOIN artists ar ON ar.id = al.artist_id`;

export type AlbumFilter = "all" | "purchased" | "wishlist";
const FILTERS: Record<AlbumFilter, string | null> = { all: null, purchased: "al.owned = 1", wishlist: WISHLISTED };

// Bandcamp release dates are stored as sent ("01 Oct 2021 00:00:00 GMT"), which does not
// sort as text. This turns them into YYYY + month position + DD; NULL stays NULL (last in DESC).
// Expects the albums table aliased as `al`.
export const RELEASE_KEY = `(substr(al.release_date, 8, 4) || printf('%02d', instr('JanFebMarAprMayJunJulAugSepOctNovDec', substr(al.release_date, 4, 3))) || substr(al.release_date, 1, 2))`;

/**
 * Library sort orders, in the order the UI offers them. A new order is one entry here plus
 * its ORDER BY in SORTS. "played" and "plays" put never-played albums last, newest first
 * (NULL sorts last in DESC).
 */
export const ALBUM_SORTS = ["added", "played", "plays", "artist", "title", "release"] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];
const SORTS: Record<AlbumSort, string> = {
  added: "al.created_at DESC, al.id DESC",
  played: "last_played_at DESC, al.created_at DESC, al.id DESC",
  plays: "play_count DESC, last_played_at DESC, al.created_at DESC, al.id DESC",
  artist: `ar.name COLLATE NOCASE, ${RELEASE_KEY} DESC, al.id DESC`,
  title: "al.title COLLATE NOCASE, ar.name COLLATE NOCASE, al.id",
  release: `${RELEASE_KEY} DESC, al.title COLLATE NOCASE, al.id`,
};

const MATCH = `(al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND (t.title LIKE ? ESCAPE '\\' OR t.track_artist LIKE ? ESCAPE '\\')))`;

/**
 * The library's albums. `q` matches album title, artist name, track titles and track
 * artists as a substring (case-insensitive for ASCII), combined with `filter`.
 */
export async function listAlbums(db: Db, sort: AlbumSort = "added", filter: AlbumFilter = "all", q = ""): Promise<Album[]> {
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
  const sql = `${ALBUM_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${SORTS[sort] ?? SORTS.added}`;
  return (await db.select<AlbumRow>(sql, params)).map(rowToAlbum);
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
