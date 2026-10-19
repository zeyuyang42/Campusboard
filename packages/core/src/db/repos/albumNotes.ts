import type { Db } from "../Db.js";
import { now, valuesList } from "../Db.js";

/**
 * Personal notes and 0-5 star ratings per album (#73, table album_notes, migration 0009).
 * Rating and note are saved separately, so a debounced note save can't undo a star click
 * made meanwhile. Each save is one statement that writes nothing once the album is gone.
 */
export interface AlbumNote { rating: number; note: string; updated_at: string }

export const NOTE_MAX = 2000;
export const RATING_MAX = 5;

/** At most NOTE_MAX characters (code points, as SQLite's length() counts them). */
export function clampNote(note: string): string {
  const chars = Array.from(note);
  return chars.length <= NOTE_MAX ? note : chars.slice(0, NOTE_MAX).join("");
}

export function clampRating(rating: number): number {
  return Number.isFinite(rating) ? Math.max(0, Math.min(RATING_MAX, Math.round(rating))) : 0;
}

export async function getAlbumNote(db: Db, albumId: number): Promise<AlbumNote | null> {
  return db.get<AlbumNote>("SELECT rating, note, updated_at FROM album_notes WHERE album_id = ?", [albumId]);
}

async function upsert(db: Db, albumId: number, col: "rating" | "note", value: number | string): Promise<void> {
  await db.run(
    `INSERT INTO album_notes (album_id, ${col}, updated_at) SELECT id, ?, ? FROM albums WHERE id = ?
     ON CONFLICT(album_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at`,
    [value, now(), albumId],
  );
}

/** 0 clears the rating. */
export const setAlbumRating = (db: Db, albumId: number, rating: number) => upsert(db, albumId, "rating", clampRating(rating));
export const setAlbumNote = (db: Db, albumId: number, note: string) => upsert(db, albumId, "note", clampNote(note));

/** Every album's note and rating by album URL, for the library export. */
export async function exportAlbumNotes(db: Db): Promise<({ album_url: string } & AlbumNote)[]> {
  return db.select("SELECT al.url AS album_url, n.rating, n.note, n.updated_at FROM album_notes n JOIN albums al ON al.id = n.album_id ORDER BY al.id");
}

/**
 * Queue notes from a library file by album URL. A note already waiting for the same album is
 * replaced only by a newer one; mergePendingNotes writes them once their albums are here.
 */
export async function addPendingNotes(db: Db, rows: ({ album_url: string } & AlbumNote)[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db.run(
      `INSERT INTO album_notes_pending (album_url, rating, note, updated_at) VALUES ${valuesList(chunk.length, 4)}
       ON CONFLICT(album_url) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_at = excluded.updated_at
       WHERE excluded.updated_at > album_notes_pending.updated_at`,
      chunk.flatMap((r) => [r.album_url, clampRating(r.rating), clampNote(r.note), r.updated_at]),
    );
  }
}

/**
 * Write waiting notes whose albums are here (only `albumId`'s when given), never over a local
 * edit that is as new or newer, then forget them. Safe to repeat.
 */
export async function mergePendingNotes(db: Db, albumId?: number): Promise<number> {
  if (!(await db.get("SELECT 1 AS x FROM album_notes_pending LIMIT 1"))) return 0;
  const only = albumId === undefined ? "" : "AND a.id = ?";
  const p = albumId === undefined ? [] : [albumId];
  const n = (await db.run(
    `INSERT INTO album_notes (album_id, rating, note, updated_at)
     SELECT a.id, p.rating, p.note, p.updated_at FROM album_notes_pending p JOIN albums a ON a.url = p.album_url WHERE 1 ${only}
     ON CONFLICT(album_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_at = excluded.updated_at
     WHERE excluded.updated_at > album_notes.updated_at`,
    p,
  )).changes;
  await db.run(`DELETE FROM album_notes_pending WHERE album_url IN (SELECT a.url FROM albums a WHERE 1 ${only})`, p);
  return n;
}
