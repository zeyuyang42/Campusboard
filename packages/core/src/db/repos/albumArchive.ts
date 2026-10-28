import type { Db } from "../Db.js";
import { chunks, now, valuesList } from "../Db.js";

/**
 * Archive (#126, table album_archive, migration 0013): one flag per album that takes it out of
 * the Library's Albums tab (grid, Recently played row, bulk bar) unless Show is Archived.
 * Artists, Tracks, Tags, Stats, playlists, smart playlists, the queue, history, the album
 * page and by-URL lookups all still see an archived album. Every write is one idempotent
 * statement that writes nothing once the album is gone.
 */

/** An archived album (expects the albums table aliased as `al`). */
export const ARCHIVED = "EXISTS (SELECT 1 FROM album_archive x WHERE x.album_id = al.id)";
export const NOT_ARCHIVED = `NOT ${ARCHIVED}`;

/**
 * How a listing treats archived albums: left out (the Albums tab), only them (Show →
 * Archived) or included like any other (everything else).
 */
export type ArchiveScope = "hide" | "only" | "any";

/** Archive or unarchive one album. True when the row changed. */
export async function setArchived(db: Db, albumId: number, archived: boolean): Promise<boolean> {
  return (await setArchivedMany(db, [albumId], archived)) > 0;
}

/** Archive or unarchive several albums (one statement per 500). Returns how many rows changed. */
export async function setArchivedMany(db: Db, albumIds: number[], archived: boolean): Promise<number> {
  let n = 0;
  for (const chunk of chunks([...new Set(albumIds)], 500)) {
    const ids = JSON.stringify(chunk);
    n += (await db.run(
      archived
        ? `INSERT OR IGNORE INTO album_archive (album_id, archived_at) SELECT a.id, ? FROM albums a WHERE a.id IN (SELECT j.value FROM json_each(?) AS j)`
        : "DELETE FROM album_archive WHERE album_id IN (SELECT j.value FROM json_each(?) AS j)",
      archived ? [now(), ids] : [ids],
    )).changes;
  }
  return n;
}

export async function isArchived(db: Db, albumId: number): Promise<boolean> {
  return !!(await db.get("SELECT 1 AS x FROM album_archive WHERE album_id = ?", [albumId]));
}

export interface ArchivedExport { album_url: string; archived_at: string }

/** Every archived album by URL, for the library export. */
export function exportArchived(db: Db): Promise<ArchivedExport[]> {
  return db.select<ArchivedExport>("SELECT al.url AS album_url, x.archived_at FROM album_archive x JOIN albums al ON al.id = x.album_id ORDER BY al.id");
}

/** Queue archive marks from a library file by album URL; mergePendingArchive writes them once their albums are here. */
export async function addPendingArchive(db: Db, rows: ArchivedExport[]): Promise<void> {
  for (const chunk of chunks(rows, 500)) {
    await db.run(
      `INSERT INTO album_archive_pending (album_url, archived_at) VALUES ${valuesList(chunk.length, 2)}
       ON CONFLICT(album_url) DO UPDATE SET archived_at = excluded.archived_at`,
      chunk.flatMap((r) => [r.album_url, r.archived_at]),
    );
  }
}

/**
 * Archive the waiting albums that are here (only `albumId`'s when given), keeping an earlier
 * local mark's time, then forget them. A file never unarchives: only an archived album is in
 * it, so an album the user unarchived here since stays as it is. Safe to repeat.
 */
export async function mergePendingArchive(db: Db, albumId?: number): Promise<number> {
  if (!(await db.get("SELECT 1 AS x FROM album_archive_pending LIMIT 1"))) return 0;
  const only = albumId === undefined ? "" : "AND a.id = ?";
  const p = albumId === undefined ? [] : [albumId];
  const n = (await db.run(
    `INSERT OR IGNORE INTO album_archive (album_id, archived_at)
     SELECT a.id, p.archived_at FROM album_archive_pending p JOIN albums a ON a.url = p.album_url WHERE 1 ${only}`,
    p,
  )).changes;
  await db.run(`DELETE FROM album_archive_pending WHERE album_url IN (SELECT a.url FROM albums a WHERE 1 ${only})`, p);
  return n;
}
