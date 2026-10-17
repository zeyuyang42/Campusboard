import type { Db } from "../Db.js";
import { now } from "../Db.js";
import { ALBUM_SELECT, rowToAlbum, type AlbumRow } from "./albums.js";
import type { Album } from "../../types.js";

/**
 * Record one counted play. A single INSERT, and a no-op (null) if the track has left the
 * library in the meantime. Returns the new row's id.
 *
 * `played_at` is when the play counted (the threshold was crossed), not when the track
 * started. `seconds_listened` is the listened time at that moment: the threshold plus at most
 * one progress report's step, so effectively capped at min(50%, 4 min); listening after that
 * isn't recorded.
 */
export async function recordPlay(db: Db, trackId: number, seconds: number): Promise<number | null> {
  const r = await db.get<{ id: number }>(
    "INSERT INTO plays (track_id, played_at, seconds_listened) SELECT id, ?, ? FROM tracks WHERE id = ? RETURNING id",
    [now(), Math.max(0, seconds), trackId],
  );
  return r?.id ?? null;
}

/** Played albums, latest play first, each with play_count and last_played_at. */
export function recentlyPlayedAlbums(db: Db, limit = 12): Promise<Album[]> {
  return historyAlbums(db, "h_last DESC, h_seq DESC", limit);
}

/** Played albums by total plays (ties: played more recently first). */
export function mostPlayedAlbums(db: Db, limit = 12): Promise<Album[]> {
  return historyAlbums(db, "h_n DESC, h_last DESC, h_seq DESC", limit);
}

async function historyAlbums(db: Db, order: string, limit: number): Promise<Album[]> {
  // One pass over plays picks the albums; the rows themselves come from the usual album select.
  const sql = `${ALBUM_SELECT}
    JOIN (SELECT t.album_id AS hid, COUNT(*) AS h_n, MAX(p.played_at) AS h_last, MAX(p.id) AS h_seq
          FROM plays p JOIN tracks t ON t.id = p.track_id
          GROUP BY t.album_id ORDER BY ${order} LIMIT ?) h ON h.hid = al.id
    ORDER BY ${order}`;
  return (await db.select<AlbumRow>(sql, [limit])).map(rowToAlbum);
}

/** How many plays are recorded. */
export async function countPlays(db: Db): Promise<number> {
  return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plays"))?.n ?? 0;
}

/** Forget all listening history. Returns the number of plays removed. */
export async function clearPlays(db: Db): Promise<number> {
  return (await db.run("DELETE FROM plays")).changes;
}
