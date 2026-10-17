import type { Db } from "../Db.js";
import { valuesList } from "../Db.js";
import type { FanItem, FanList } from "../../scrape/fan.js";

/** SQL guard: the sync job is still running (not cancelled by removing or changing the account). */
const JOB_RUNNING = "EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')";

/**
 * Record that `items` are on `list` as of sync job `jobId`. Chunked single statements,
 * each safe to repeat and each a no-op once the job is cancelled, so removing the account
 * mid-sync can't be undone by a write already on its way. Call before removeUnseen, and
 * recomputeOwned after both.
 */
export async function upsertFanItems(db: Db, list: FanList, items: FanItem[], jobId: number): Promise<void> {
  const COLS = 8;
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    await db.run(
      `INSERT INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, title, artist, sync_job)
       SELECT * FROM (VALUES ${valuesList(chunk.length, COLS)}) WHERE ${JOB_RUNNING}
       ON CONFLICT(list, item_type, bandcamp_id) DO UPDATE SET
         url = excluded.url, fetch_url = excluded.fetch_url, title = excluded.title, artist = excluded.artist, sync_job = excluded.sync_job`,
      [...chunk.flatMap((it) => [list, it.item_type, it.bandcamp_id, it.url, it.fetch_url, it.title, it.artist, jobId]), jobId],
    );
  }
}

/** Drop items sync job `jobId` no longer saw on `list` (only while that job still runs). */
export async function removeUnseen(db: Db, list: FanList, jobId: number): Promise<void> {
  await db.run(`DELETE FROM fan_items WHERE list = ? AND sync_job != ? AND ${JOB_RUNNING}`, [list, jobId, jobId]);
}

/**
 * Remember that the synced items an album holds were removed from the library, so syncs
 * stop importing them. Runs before the album's delete (its tracks are needed here).
 */
export async function dismissAlbum(db: Db, albumId: number): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO fan_dismissed (item_type, bandcamp_id)
     SELECT f.item_type, f.bandcamp_id FROM fan_items f JOIN albums a ON a.id = ?
     WHERE (f.item_type = a.item_type AND f.bandcamp_id = a.bandcamp_id)
        OR (f.item_type = 'track' AND f.bandcamp_id IN (SELECT track_id FROM tracks WHERE album_id = a.id))`,
    [albumId],
  );
}

/** An explicit import brings a release back: forget its dismissal and its tracks'. */
export async function undismiss(db: Db, itemType: string, bandcampId: number, trackIds: number[]): Promise<void> {
  await db.run(
    `DELETE FROM fan_dismissed WHERE (item_type = ? AND bandcamp_id = ?)
     ${trackIds.length ? `OR (item_type = 'track' AND bandcamp_id IN (${trackIds.map(() => "?").join(",")}))` : ""}`,
    [itemType, bandcampId, ...trackIds],
  );
}

/** Forget the account's lists (username changed or cleared). Follow with recomputeOwned. */
export async function clearFanItems(db: Db): Promise<void> {
  await db.run("DELETE FROM fan_items");
}

/** Set albums.owned from the collection rows, in one statement, touching only rows that change. */
export async function recomputeOwned(db: Db): Promise<void> {
  const owned = "EXISTS (SELECT 1 FROM fan_items f WHERE f.list = 'collection' AND f.item_type = albums.item_type AND f.bandcamp_id = albums.bandcamp_id)";
  await db.run(`UPDATE albums SET owned = ${owned} WHERE owned != ${owned}`);
}

export async function countFanItems(db: Db): Promise<Record<FanList, number>> {
  const rows = await db.select<{ list: FanList; n: number }>("SELECT list, COUNT(*) AS n FROM fan_items GROUP BY list");
  const out: Record<FanList, number> = { collection: 0, wishlist: 0 };
  for (const r of rows) out[r.list] = r.n;
  return out;
}

/**
 * Fetch URLs of synced items not yet in the library and not removed from it by the user, purchases first. A track counts as
 * present when its track already lives in any album (a single-track page adds nothing then).
 */
export async function missingFetchUrls(db: Db): Promise<string[]> {
  const rows = await db.select<{ fetch_url: string }>(
    `SELECT fetch_url, MIN(CASE list WHEN 'collection' THEN 0 ELSE 1 END) AS pri, MIN(rowid) AS ord FROM fan_items f
     WHERE NOT EXISTS (SELECT 1 FROM albums a WHERE a.item_type = f.item_type AND a.bandcamp_id = f.bandcamp_id)
       AND NOT (f.item_type = 'track' AND EXISTS (SELECT 1 FROM tracks t WHERE t.track_id = f.bandcamp_id))
       AND NOT EXISTS (SELECT 1 FROM fan_dismissed d WHERE d.item_type = f.item_type AND d.bandcamp_id = f.bandcamp_id)
     GROUP BY fetch_url ORDER BY pri, ord`,
  );
  return rows.map((r) => r.fetch_url);
}

/** Library album already holding the item behind a fetch URL (its own row, or the album its track is in). */
export async function libraryAlbumForFetchUrl(db: Db, fetchUrl: string): Promise<number | null> {
  const r = await db.get<{ id: number | null }>(
    `SELECT COALESCE(
       (SELECT a.id FROM albums a WHERE a.item_type = f.item_type AND a.bandcamp_id = f.bandcamp_id),
       (SELECT t.album_id FROM tracks t WHERE f.item_type = 'track' AND t.track_id = f.bandcamp_id)) AS id
     FROM fan_items f WHERE f.fetch_url = ? LIMIT 1`,
    [fetchUrl],
  );
  return r?.id ?? null;
}

/** Whether a fetch URL belongs to a purchased item (so the identity cookie may unlock mp3-v0). */
export async function isCollectionFetchUrl(db: Db, fetchUrl: string): Promise<boolean> {
  return !!(await db.get("SELECT 1 AS x FROM fan_items WHERE list = 'collection' AND fetch_url = ?", [fetchUrl]));
}

/** The name.bandcamp.com URL of a purchased library album, for refreshing it with the cookie. */
export async function ownedFetchUrl(db: Db, albumId: number): Promise<string | null> {
  const r = await db.get<{ fetch_url: string }>(
    `SELECT f.fetch_url FROM albums a JOIN fan_items f ON f.list = 'collection' AND f.item_type = a.item_type AND f.bandcamp_id = a.bandcamp_id
     WHERE a.id = ?`,
    [albumId],
  );
  return r?.fetch_url ?? null;
}
