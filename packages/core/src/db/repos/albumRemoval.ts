// Album removal with Undo (#93): the delete waits out the Undo window. Meanwhile the album
// is only marked (a settings row, so no migration), and every listing leaves it out. The
// marks are read and written with single statements, so two removals never lose each other.
import type { Db } from "../Db.js";
import { now } from "../Db.js";

/** settings key: albums removed but still within their Undo window (#93), a JSON array of ids. */
export const REMOVING_KEY = "albums_removing";

/**
 * Leaves out albums waiting for their delete (#93; expects `al`): the Library, its tags, bulk
 * actions and smart playlists all go through albumWhere; track search and artists add it.
 * A damaged value (not JSON, or entries that are not whole numbers) hides nothing rather than
 * failing the query or hiding everything.
 */
export const NOT_REMOVING = `al.id NOT IN (SELECT rm.value FROM settings s, json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '[]' END) rm
  WHERE s.key = '${REMOVING_KEY}' AND rm.type = 'integer')`;


/** Mark an album for removal (one statement). False when there is no such album or it is marked already. */
export async function markRemoving(db: Db, albumId: number): Promise<boolean> {
  const r = await db.run(
    `INSERT INTO settings (key, value, updated_at) SELECT ?, json_array(CAST(? AS INTEGER)), ? WHERE EXISTS (SELECT 1 FROM albums WHERE id = ?)
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_valid(settings.value) AND json_type(settings.value) = 'array'
       THEN json_insert(settings.value, '$[#]', CAST(? AS INTEGER)) ELSE excluded.value END, updated_at = excluded.updated_at
     WHERE NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '[]' END) rm WHERE rm.value = ?)`,
    [REMOVING_KEY, albumId, now(), albumId, albumId, albumId],
  );
  return r.changes > 0;
}

/** Take marks off (Undo, or after the delete). One statement. */
export async function unmarkRemoving(db: Db, albumIds: number[]): Promise<void> {
  if (!albumIds.length) return;
  await db.run(
    `UPDATE settings SET value = (SELECT json_group_array(rm.value) FROM json_each(settings.value) rm WHERE rm.value NOT IN (SELECT x.value FROM json_each(?) x)),
       updated_at = ? WHERE key = ? AND json_valid(value) AND json_type(value) = 'array'`,
    [JSON.stringify(albumIds), now(), REMOVING_KEY],
  );
}

/** The albums marked for removal, without duplicates. */
export async function removingAlbumIds(db: Db): Promise<number[]> {
  const rows = await db.select<{ id: number }>(
    `SELECT DISTINCT rm.value AS id FROM settings s, json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '[]' END) rm
     WHERE s.key = ? AND rm.type = 'integer'`,
    [REMOVING_KEY],
  );
  return rows.map((r) => r.id);
}
