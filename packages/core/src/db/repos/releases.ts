import type { Db } from "../Db.js";
import { chunks, placeholders, valuesList } from "../Db.js";
import type { ItemType, NewRelease } from "../../types.js";

/** A release URL as a check stores it. */
export interface ReleaseRow {
  url: string;
  item_type: ItemType;
  title: string;
  art_id: number | null;
  artist_override: string | null;
  status: "seen" | "new";
}

export interface WatchRow {
  artist_id: number;
  muted: number;
  baselined: number;
  last_checked_at: number | null;
  last_error: string | null;
}

export interface WatchedArtist { id: number; url: string; name: string }

/** Artists with at least one album in the library: removing the last album ends their checks. */
const IN_LIBRARY = "EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = ar.id)";

/**
 * The library artist whose check is most overdue (never checked first), or null when every
 * unmuted artist was checked within `intervalMs` of `now`.
 */
export function nextDueArtist(db: Db, now: number, intervalMs: number): Promise<WatchedArtist | null> {
  return db.get<WatchedArtist>(
    `SELECT ar.id, ar.url, ar.name FROM artists ar LEFT JOIN release_watch w ON w.artist_id = ar.id
     WHERE ${IN_LIBRARY} AND COALESCE(w.muted, 0) = 0 AND (w.last_checked_at IS NULL OR w.last_checked_at <= ?)
     ORDER BY w.last_checked_at IS NOT NULL, w.last_checked_at, ar.id LIMIT 1`,
    [now - intervalMs],
  );
}

/** Every unmuted library artist, least recently checked first. */
export function watchedArtists(db: Db): Promise<WatchedArtist[]> {
  return db.select<WatchedArtist>(
    `SELECT ar.id, ar.url, ar.name FROM artists ar LEFT JOIN release_watch w ON w.artist_id = ar.id
     WHERE ${IN_LIBRARY} AND COALESCE(w.muted, 0) = 0
     ORDER BY w.last_checked_at IS NOT NULL, w.last_checked_at, ar.id`,
  );
}

export function getWatch(db: Db, artistId: number): Promise<WatchRow | null> {
  return db.get<WatchRow>("SELECT * FROM release_watch WHERE artist_id = ?", [artistId]);
}

/**
 * Store the releases a check saw. URLs already known keep their row and status (ON CONFLICT
 * DO NOTHING), so repeating an interrupted check changes nothing it already wrote.
 * Returns the rows inserted.
 */
export async function insertReleases(db: Db, artistId: number, rows: ReleaseRow[]): Promise<{ id: number; status: ReleaseRow["status"] }[]> {
  const ids: { id: number; status: ReleaseRow["status"] }[] = [];
  const COLS = 7;
  for (const chunk of chunks(rows, 100)) {
    const got = await db.select<{ id: number; status: ReleaseRow["status"] }>(
      `INSERT INTO artist_releases (artist_id, url, item_type, title, art_id, artist_override, status)
       VALUES ${valuesList(chunk.length, COLS)} ON CONFLICT(url) DO NOTHING RETURNING id, status`,
      chunk.flatMap((r) => [artistId, r.url, r.item_type, r.title, r.art_id, r.artist_override, r.status]),
    );
    ids.push(...got);
  }
  return ids;
}

/**
 * Record a check, after its releases are stored. Only a successful one completes the
 * baseline; a failed one still counts as the day's check so a broken page isn't retried
 * every tick. Only while the artist still exists (a removal in between wins).
 */
export async function markChecked(db: Db, artistId: number, at: number, ok: boolean, error: string | null): Promise<void> {
  await db.run(
    `INSERT INTO release_watch (artist_id, baselined, last_checked_at, last_error)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artists WHERE id = ?)
     ON CONFLICT(artist_id) DO UPDATE SET baselined = MAX(release_watch.baselined, excluded.baselined),
       last_checked_at = excluded.last_checked_at, last_error = excluded.last_error`,
    [artistId, ok ? 1 : 0, at, error, artistId],
  );
}

export async function setMuted(db: Db, artistId: number, muted: boolean): Promise<void> {
  await db.run(
    `INSERT INTO release_watch (artist_id, muted) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM artists WHERE id = ?)
     ON CONFLICT(artist_id) DO UPDATE SET muted = excluded.muted`,
    [artistId, muted ? 1 : 0, artistId],
  );
}

export async function isMuted(db: Db, artistId: number): Promise<boolean> {
  return !!(await db.get<{ muted: number }>("SELECT muted FROM release_watch WHERE artist_id = ?", [artistId]))?.muted;
}

/**
 * SQL for the path of a stored URL ("/album/slug", "/track/slug"). Every stored URL is a
 * normalizeBandcampUrl result, "https://<host>/<kind>/<slug>", so the path starts at the
 * first "/" after the 8-character scheme. Releases are matched per artist on this path,
 * ignoring the host, so an artist adding, changing or dropping a custom domain doesn't
 * turn the back catalogue into "new" releases.
 */
export const pathSql = (col: string) => `substr(${col}, instr(substr(${col}, 9), '/') + 8)`;

/** "/album/slug" for a normalized release URL (the JS twin of pathSql). */
export function releasePath(url: string): string {
  return url.slice(url.indexOf("/", 8));
}

/** The library holds this release: same URL, or the same path under the same artist. */
const IN_ALBUMS = `EXISTS (SELECT 1 FROM albums a WHERE a.url = r.url OR (a.artist_id = r.artist_id AND ${pathSql("a.url")} = ${pathSql("r.url")}))`;

/**
 * What the New releases page lists: 'new' rows that aren't in the library (IN_ALBUMS), aren't
 * a synced purchase or wishlist item the user removed from the library (fan_dismissed), and
 * whose artist isn't muted.
 */
const LISTED = `r.status = 'new'
  AND NOT ${IN_ALBUMS}
  AND NOT EXISTS (SELECT 1 FROM fan_items f JOIN fan_dismissed d ON d.item_type = f.item_type AND d.bandcamp_id = f.bandcamp_id
                  WHERE f.url = r.url OR f.fetch_url = r.url)
  AND COALESCE((SELECT w.muted FROM release_watch w WHERE w.artist_id = r.artist_id), 0) = 0`;

/** Listed new releases: the latest finds first, each check's finds in page order (newest first on Bandcamp). */
export function listNewReleases(db: Db): Promise<NewRelease[]> {
  return db.select<NewRelease>(
    `SELECT r.id, r.artist_id, COALESCE(r.artist_override, ar.name) AS artist_name, r.url, r.item_type, r.title, r.art_id, r.first_seen
     FROM artist_releases r JOIN artists ar ON ar.id = r.artist_id
     WHERE ${LISTED} ORDER BY r.first_seen DESC, r.id`,
  );
}

export async function countNewReleases(db: Db): Promise<number> {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artist_releases r JOIN artists ar ON ar.id = r.artist_id WHERE ${LISTED}`))?.n ?? 0;
}

/** Paths of every release stored for an artist (any status, any host). */
export async function knownPaths(db: Db, artistId: number): Promise<Set<string>> {
  const rows = await db.select<{ url: string }>("SELECT url FROM artist_releases WHERE artist_id = ?", [artistId]);
  return new Set(rows.map((r) => releasePath(r.url)));
}

/** Paths of an artist's albums in the library (any host). */
export async function libraryPaths(db: Db, artistId: number): Promise<Set<string>> {
  const rows = await db.select<{ url: string }>("SELECT url FROM albums WHERE artist_id = ?", [artistId]);
  return new Set(rows.map((r) => releasePath(r.url)));
}

/** A new release that made it into the library is no longer new, even if it's removed again later. */
export async function settleImported(db: Db): Promise<void> {
  await db.run(`UPDATE artist_releases AS r SET status = 'seen' WHERE r.status = 'new' AND ${IN_ALBUMS}`);
}

/**
 * An import job item succeeded: the release it fetched (same URL, or the same path under the
 * artist of the album it landed in) is no longer new. One statement.
 */
export async function settleRelease(db: Db, url: string, albumId: number): Promise<void> {
  await db.run(
    `UPDATE artist_releases SET status = 'seen' WHERE status = 'new'
     AND (url = ? OR (artist_id = (SELECT artist_id FROM albums WHERE id = ?) AND ${pathSql("url")} = ?))`,
    [url, albumId, releasePath(url)],
  );
}

/** Dismiss the given new releases, 100 ids per statement. Returns how many changed. */
export async function dismissReleases(db: Db, ids: number[]): Promise<number> {
  let n = 0;
  const clean = [...new Set(ids.filter((i) => Number.isInteger(i)))];
  for (const chunk of chunks(clean, 100)) {
    n += (await db.run(`UPDATE artist_releases SET status = 'dismissed' WHERE status = 'new' AND id IN (${placeholders(chunk.length)})`, chunk)).changes;
  }
  return n;
}

/** Last check time and how many library artists are covered or muted. */
export async function watchSummary(db: Db): Promise<{ last_check_at: number | null; artists: number; muted: number }> {
  const r = await db.get<{ last: number | null; artists: number | null; muted: number | null }>(
    `SELECT (SELECT MAX(w2.last_checked_at) FROM release_watch w2 JOIN artists a2 ON a2.id = w2.artist_id) AS last,
       SUM(CASE WHEN COALESCE(w.muted, 0) = 0 THEN 1 ELSE 0 END) AS artists,
       SUM(CASE WHEN w.muted = 1 THEN 1 ELSE 0 END) AS muted
     FROM artists ar LEFT JOIN release_watch w ON w.artist_id = ar.id WHERE ${IN_LIBRARY}`,
  );
  return { last_check_at: r?.last ?? null, artists: r?.artists ?? 0, muted: r?.muted ?? 0 };
}
