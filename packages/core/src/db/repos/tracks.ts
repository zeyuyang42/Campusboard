import type { Db } from "../Db.js";
import { likeContains } from "../Db.js";
import type { Track } from "../../types.js";

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
    ? await db.select<TrackRow>(`${TRACK_SELECT} WHERE t.title LIKE ? ESCAPE '\\' OR t.track_artist LIKE ? ESCAPE '\\' OR al.title LIKE ? ESCAPE '\\' OR ar.name LIKE ? ESCAPE '\\' ORDER BY ar.name COLLATE NOCASE, al.title, t.track_num LIMIT ?`, [like, like, like, like, limit])
    : await db.select<TrackRow>(`${TRACK_SELECT} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`, [limit]);
  return rows.map(rowToTrack);
}

export async function getTracksByIds(db: Db, ids: number[]): Promise<Track[]> {
  if (ids.length === 0) return [];
  const rows = await db.select<TrackRow>(`${TRACK_SELECT} WHERE t.id IN (${ids.map(() => "?").join(",")})`, ids);
  const byId = new Map(rows.map((r) => [r.id, rowToTrack(r)]));
  return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t);
}
