import type { Db } from "../Db.js";
import { chunks, likeContains, placeholders } from "../Db.js";
import type { Track } from "../../types.js";
import { NOT_REMOVING } from "./albumRemoval.js";

export interface TrackRow {
  id: number;
  track_id: number;
  album_id: number;
  title: string;
  track_num: number | null;
  duration: number | null;
  track_artist: string | null;
  streamable: number;
  stream_url: string | null;
  stream_expires_at: number | null;
  lyrics: string | null;
  /** The offline copy's file name (#2), or null. */
  local_path: string | null;
  album_title: string;
  album_url: string;
  album_item_type: "album" | "track";
  artist_name: string;
  art_id: number | null;
  play_count: number;
}

/** Track columns with their album's and artist's; ends with the FROM/JOINs (t, al, ar) so callers can add joins and WHERE. */
export const TRACK_SELECT = `
  SELECT t.*, al.title AS album_title, al.url AS album_url, al.item_type AS album_item_type,
         al.art_id AS art_id, ar.name AS artist_name,
         (SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id) AS play_count
  FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id`;

export function getTrackRow(db: Db, id: number): Promise<TrackRow | null> {
  return db.get<TrackRow>(`${TRACK_SELECT} WHERE t.id = ?`, [id]);
}

export function rowToTrack(r: TrackRow): Track {
  const { stream_url: _u, stream_expires_at: _e, album_item_type: _t, local_path: _l, ...rest } = r;
  return { ...rest, streamable: !!r.streamable, downloaded: !!r.local_path };
}

export async function searchTracks(db: Db, q: string, limit = 500): Promise<Track[]> {
  const like = likeContains(q.trim());
  const rows = q.trim()
    ? await db.select<TrackRow>(`${TRACK_SELECT} WHERE ${NOT_REMOVING} AND (t.title LIKE ? ESCAPE '\\' OR t.track_artist LIKE ? ESCAPE '\\' OR al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\') ORDER BY ar.name COLLATE NOCASE, al.title, t.track_num LIMIT ?`, [like, like, like, like, limit])
    : await db.select<TrackRow>(`${TRACK_SELECT} WHERE ${NOT_REMOVING} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`, [limit]);
  return rows.map(rowToTrack);
}

export async function getTracksByIds(db: Db, ids: number[]): Promise<Track[]> {
  if (ids.length === 0) return [];
  const rows = await db.select<TrackRow>(`${TRACK_SELECT} WHERE t.id IN (${placeholders(ids.length)})`, ids);
  const byId = new Map(rows.map((r) => [r.id, rowToTrack(r)]));
  return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t);
}

/** Which of these library tracks have an offline copy (#2), by the rows alone: no file checks. */
export async function downloadedIds(db: Db, trackIds: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  for (const chunk of chunks(trackIds, 500)) {
    out.push(...(await db.select<{ id: number }>(`SELECT id FROM tracks WHERE local_path IS NOT NULL AND id IN (${placeholders(chunk.length)})`, chunk)).map((r) => r.id));
  }
  return out;
}

/** A library track by its Bandcamp track id: the row id and the album it is in, or null. */
export function byBandcampId(db: Db, bandcampTrackId: number): Promise<{ id: number; album_id: number } | null> {
  return db.get<{ id: number; album_id: number }>("SELECT id, album_id FROM tracks WHERE track_id = ?", [bandcampTrackId]);
}
