import type { Db } from "../Db.js";
import { chunks, now } from "../Db.js";
import type { Crate } from "../../types.js";
import { normalizePlaylistName, PlaylistNameError } from "./playlists.js";

/**
 * Crates (#126, tables crates and crate_albums, migration 0013): the user's own groups of
 * albums, nothing to do with Bandcamp's tags. An album may be in any number of crates. A
 * crate is listed in the sidebar and opens the Library's Albums grid narrowed to it (the
 * `crate` condition in albums.ts), so Sort, Show, the filter text and bulk actions apply.
 * No transactions: each write is one idempotent statement that writes nothing once the
 * album or crate is gone.
 */

export const CRATE_NAME_MAX = 100;

/** The same rule as playlist names: trimmed, spaces collapsed, at most CRATE_NAME_MAX characters, null when empty. */
export const normalizeCrateName = normalizePlaylistName;

/** Thrown by createCrate/renameCrate when the name is empty after normalisation. */
export class CrateNameError extends PlaylistNameError {
  constructor() {
    super("Crate name can't be empty.");
    this.name = "CrateNameError";
  }
}

function requireName(name: string): string {
  const n = normalizeCrateName(name);
  if (!n) throw new CrateNameError();
  return n;
}

interface CrateRow extends Omit<Crate, "art_ids"> { art_ids_csv: string | null }

function rowToCrate(r: CrateRow): Crate {
  const { art_ids_csv, ...rest } = r;
  const seen = new Set<number>();
  const art_ids: number[] = [];
  for (const s of (art_ids_csv ?? "").split(",")) {
    const n = Number(s);
    if (s && Number.isFinite(n) && !seen.has(n)) { seen.add(n); art_ids.push(n); }
    if (art_ids.length === 4) break;
  }
  return { ...rest, art_ids };
}

const CRATE_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM crate_albums ca WHERE ca.crate_id = c.id) AS album_count,
    (SELECT GROUP_CONCAT(art_id) FROM (
       SELECT al.art_id FROM crate_albums ca JOIN albums al ON al.id = ca.album_id
       WHERE ca.crate_id = c.id AND al.art_id IS NOT NULL ORDER BY ca.added_at, al.id LIMIT 12)) AS art_ids_csv
  FROM crates c`;

/** Every crate, by name. */
export async function listCrates(db: Db): Promise<Crate[]> {
  return (await db.select<CrateRow>(`${CRATE_SELECT} ORDER BY c.name COLLATE NOCASE, c.id`)).map(rowToCrate);
}

export async function getCrate(db: Db, id: number): Promise<Crate | null> {
  const r = await db.get<CrateRow>(`${CRATE_SELECT} WHERE c.id = ?`, [id]);
  return r ? rowToCrate(r) : null;
}

export async function createCrate(db: Db, name: string): Promise<Crate> {
  const t = now();
  const r = await db.get<{ id: number }>("INSERT INTO crates (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id", [requireName(name), t, t]);
  return (await getCrate(db, r!.id))!;
}

export async function renameCrate(db: Db, id: number, name: string): Promise<boolean> {
  return (await db.run("UPDATE crates SET name = ?, updated_at = ? WHERE id = ?", [requireName(name), now(), id])).changes > 0;
}

/** The crates an album is in, by name. */
export async function cratesOf(db: Db, albumId: number): Promise<Crate[]> {
  return (await db.select<CrateRow>(
    `${CRATE_SELECT} WHERE EXISTS (SELECT 1 FROM crate_albums ca WHERE ca.crate_id = c.id AND ca.album_id = ?) ORDER BY c.name COLLATE NOCASE, c.id`,
    [albumId],
  )).map(rowToCrate);
}

/**
 * How many of the given albums each crate holds, for the picker's marks (all, some, none).
 * Crates holding none of them are absent. Any number of ids (one JSON parameter).
 */
export async function cratesContaining(db: Db, albumIds: number[]): Promise<Map<number, number>> {
  if (!albumIds.length) return new Map();
  const rows = await db.select<{ crate_id: number; n: number }>(
    `SELECT crate_id, COUNT(DISTINCT album_id) AS n FROM crate_albums
     WHERE album_id IN (SELECT j.value FROM json_each(?) AS j) GROUP BY crate_id`,
    [JSON.stringify([...new Set(albumIds)])],
  );
  return new Map(rows.map((r) => [r.crate_id, r.n]));
}

const touch = (db: Db, crateId: number) => db.run("UPDATE crates SET updated_at = ? WHERE id = ?", [now(), crateId]);

/** Put albums in a crate (those already there, or gone, are skipped). Returns how many were added. */
export async function addToCrate(db: Db, crateId: number, albumIds: number[]): Promise<number> {
  let n = 0;
  for (const chunk of chunks([...new Set(albumIds)], 500)) {
    n += (await db.run(
      `INSERT OR IGNORE INTO crate_albums (crate_id, album_id, added_at)
       SELECT c.id, a.id, ? FROM crates c, albums a WHERE c.id = ? AND a.id IN (SELECT j.value FROM json_each(?) AS j)`,
      [now(), crateId, JSON.stringify(chunk)],
    )).changes;
  }
  if (n) await touch(db, crateId);
  return n;
}

/** Take albums out of a crate. Returns how many were removed. */
export async function removeFromCrate(db: Db, crateId: number, albumIds: number[]): Promise<number> {
  let n = 0;
  for (const chunk of chunks([...new Set(albumIds)], 500)) {
    n += (await db.run("DELETE FROM crate_albums WHERE crate_id = ? AND album_id IN (SELECT j.value FROM json_each(?) AS j)", [crateId, JSON.stringify(chunk)])).changes;
  }
  if (n) await touch(db, crateId);
  return n;
}

// Undo (#93): a delete takes a snapshot first and hands it to the UI, which gives it back.

/** A deleted crate: its row, memberships, import bookkeeping and entries still waiting for their album. */
export interface DeletedCrate {
  crate: { id: number; name: string; created_at: string; updated_at: string };
  albums: { album_id: number; added_at: string }[];
  imported: { source_key: string }[];
  pending: { album_url: string; added_at: string }[];
}

/** Delete a crate and return what restoreCrate needs, or null when there was none. */
export async function deleteCrateWithUndo(db: Db, id: number): Promise<DeletedCrate | null> {
  const crate = await db.get<DeletedCrate["crate"]>("SELECT id, name, created_at, updated_at FROM crates WHERE id = ?", [id]);
  if (!crate) return null;
  const albums = await db.select<DeletedCrate["albums"][number]>("SELECT album_id, added_at FROM crate_albums WHERE crate_id = ? ORDER BY added_at, album_id", [id]);
  const imported = await db.select<DeletedCrate["imported"][number]>("SELECT source_key FROM imported_crates WHERE crate_id = ?", [id]);
  const pending = await db.select<DeletedCrate["pending"][number]>("SELECT album_url, added_at FROM crate_albums_pending WHERE crate_id = ?", [id]);
  if (!(await deleteCrate(db, id))) return null;
  return { crate, albums, imported, pending };
}

/** Delete a crate outright. Children first (the foreign keys cascade them; this is also right with them off), the crate last. */
export async function deleteCrate(db: Db, id: number): Promise<boolean> {
  await db.run("DELETE FROM crate_albums WHERE crate_id = ?", [id]);
  await db.run("DELETE FROM crate_albums_pending WHERE crate_id = ?", [id]);
  await db.run("DELETE FROM imported_crates WHERE crate_id = ?", [id]);
  return (await db.run("DELETE FROM crates WHERE id = ?", [id])).changes > 0;
}

/**
 * Recreate a deleted crate under its old id when that is still free, else under a new one.
 * Parent first, then its memberships (skipping albums gone since) and bookkeeping; each step
 * skips what is there already, and the crate itself is found again by id, name and created_at.
 * Returns the crate's id.
 */
export async function restoreCrate(db: Db, snap: DeletedCrate): Promise<number> {
  const c = snap.crate;
  const again = await db.get<{ id: number }>("SELECT id FROM crates WHERE id = ? AND name = ? AND created_at = ?", [c.id, c.name, c.created_at]);
  const id = again?.id ?? (await db.get<{ id: number }>(
    `INSERT INTO crates (id, name, created_at, updated_at)
     VALUES (CASE WHEN EXISTS (SELECT 1 FROM crates WHERE id = ?) THEN NULL ELSE ? END, ?, ?, ?) RETURNING id`,
    [c.id, c.id, c.name, c.created_at, c.updated_at],
  ))!.id;
  if (snap.albums.length) {
    await db.run(
      `INSERT OR IGNORE INTO crate_albums (crate_id, album_id, added_at)
       SELECT ?, json_extract(j.value, '$.album_id'), json_extract(j.value, '$.added_at') FROM json_each(?) AS j
       WHERE EXISTS (SELECT 1 FROM albums a WHERE a.id = json_extract(j.value, '$.album_id'))`,
      [id, JSON.stringify(snap.albums)],
    );
  }
  for (const m of snap.imported) {
    await db.run(
      `INSERT INTO imported_crates (source_key, crate_id) VALUES (?, ?)
       ON CONFLICT(source_key) DO UPDATE SET crate_id = excluded.crate_id
       WHERE imported_crates.crate_id IS NULL OR imported_crates.crate_id NOT IN (SELECT id FROM crates)`,
      [m.source_key, id],
    );
  }
  if (snap.pending.length) await addPendingCrateAlbums(db, id, snap.pending);
  return id;
}

export interface CrateExport { id: number; name: string; created_at: string; albums: string[] }

/** Every crate with its albums' URLs in added order, for the library export. */
export async function exportCrates(db: Db): Promise<CrateExport[]> {
  const out: CrateExport[] = [];
  for (const c of await db.select<{ id: number; name: string; created_at: string }>("SELECT id, name, created_at FROM crates ORDER BY created_at, id")) {
    const albums = await db.select<{ url: string }>(
      "SELECT al.url FROM crate_albums ca JOIN albums al ON al.id = ca.album_id WHERE ca.crate_id = ? ORDER BY ca.added_at, ca.album_id", [c.id],
    );
    out.push({ ...c, albums: albums.map((a) => a.url) });
  }
  return out;
}

/** Queue memberships from a library file by album URL; mergePendingCrateAlbums puts them in the crate once their albums are here. */
export async function addPendingCrateAlbums(db: Db, crateId: number, rows: { album_url: string; added_at: string }[]): Promise<void> {
  for (const chunk of chunks(rows, 500)) {
    await db.run(
      `INSERT OR IGNORE INTO crate_albums_pending (crate_id, album_url, added_at)
       SELECT ?, json_extract(j.value, '$.album_url'), json_extract(j.value, '$.added_at') FROM json_each(?) AS j
       WHERE EXISTS (SELECT 1 FROM crates c WHERE c.id = ?)`,
      [crateId, JSON.stringify(chunk), crateId],
    );
  }
}

/** Put waiting memberships whose albums are here (only `albumId`'s when given) in their crates, then forget them. Safe to repeat. */
export async function mergePendingCrateAlbums(db: Db, albumId?: number): Promise<number> {
  if (!(await db.get("SELECT 1 AS x FROM crate_albums_pending LIMIT 1"))) return 0;
  const only = albumId === undefined ? "" : "AND a.id = ?";
  const p = albumId === undefined ? [] : [albumId];
  const n = (await db.run(
    `INSERT OR IGNORE INTO crate_albums (crate_id, album_id, added_at)
     SELECT p.crate_id, a.id, p.added_at FROM crate_albums_pending p JOIN albums a ON a.url = p.album_url
     WHERE EXISTS (SELECT 1 FROM crates c WHERE c.id = p.crate_id) ${only}`,
    p,
  )).changes;
  await db.run(`DELETE FROM crate_albums_pending WHERE album_url IN (SELECT a.url FROM albums a WHERE 1 ${only})`, p);
  return n;
}
