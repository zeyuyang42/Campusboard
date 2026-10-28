import type { Db } from "../Db.js";
import { now } from "../Db.js";
import { ALBUM_SELECT, rowToAlbum, type AlbumRow } from "./albums.js";
import { rowToTrack, type TrackRow } from "./tracks.js";
import type { Album, HistoryCursor, HistoryPage } from "../../types.js";

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

/**
 * Played albums, latest play first, each with play_count and last_played_at. Archived albums
 * (#126) are left out: this is the Albums tab's Recently played row.
 */
export function recentlyPlayedAlbums(db: Db, limit = 12): Promise<Album[]> {
  return historyAlbums(db, "h_last DESC, h_seq DESC", limit, true);
}

/** Played albums by total plays (ties: played more recently first). */
export function mostPlayedAlbums(db: Db, limit = 12): Promise<Album[]> {
  return historyAlbums(db, "h_n DESC, h_last DESC, h_seq DESC", limit, false);
}

async function historyAlbums(db: Db, order: string, limit: number, hideArchived: boolean): Promise<Album[]> {
  // One pass over plays picks the albums; the rows themselves come from the usual album select.
  const sql = `${ALBUM_SELECT}
    JOIN (SELECT t.album_id AS hid, COUNT(*) AS h_n, MAX(p.played_at) AS h_last, MAX(p.id) AS h_seq
          FROM plays p JOIN tracks t ON t.id = p.track_id
          ${hideArchived ? "WHERE NOT EXISTS (SELECT 1 FROM album_archive x WHERE x.album_id = t.album_id)" : ""}
          GROUP BY t.album_id ORDER BY ${order} LIMIT ?) h ON h.hid = al.id
    ORDER BY ${order}`;
  return (await db.select<AlbumRow>(sql, [limit])).map(rowToAlbum);
}

/**
 * One page of listening history (#86), newest play first. Keyset paging on (played_at, id):
 * `before` is the previous page's `next`, so plays recorded meanwhile never shift a page.
 * plays is the outer loop (CROSS JOIN fixes the order) and walks ix_plays_played_at backwards;
 * the index carries the rowid, so the id tie-break needs no sort. Rows whose track is gone
 * can't appear: an album delete takes its plays with it.
 */
export async function listPlays(db: Db, before: HistoryCursor | null = null, limit = 50): Promise<HistoryPage> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await db.select<TrackRow & { play_id: number; played_at: string }>(
    historySql(!!before),
    before ? [before.played_at, before.id, n + 1] : [n + 1],
  );
  const page = rows.slice(0, n);
  const entries = page.map(({ play_id, played_at, ...r }) => ({ ...rowToTrack(r as TrackRow), play_id, played_at }));
  const last = page[page.length - 1];
  return { entries, next: rows.length > n && last ? { played_at: last.played_at, id: last.play_id } : null };
}

/** listPlays' statement; params are [played_at, id,] limit. Exported for the query-plan test. */
export const historySql = (cursor: boolean) => `
  SELECT t.*, al.title AS album_title, al.url AS album_url, al.item_type AS album_item_type,
         al.art_id AS art_id, ar.name AS artist_name,
         (SELECT COUNT(*) FROM plays c WHERE c.track_id = t.id) AS play_count,
         p.id AS play_id, p.played_at AS played_at
  FROM plays p CROSS JOIN tracks t ON t.id = p.track_id
    JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id
  ${cursor ? "WHERE (p.played_at, p.id) < (?, ?)" : ""}
  ORDER BY p.played_at DESC, p.id DESC LIMIT ?`;

/** How many plays are recorded. */
export async function countPlays(db: Db): Promise<number> {
  return (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plays"))?.n ?? 0;
}

/** Forget all listening history. Returns the number of plays removed. */
export async function clearPlays(db: Db): Promise<number> {
  return (await db.run("DELETE FROM plays")).changes;
}
