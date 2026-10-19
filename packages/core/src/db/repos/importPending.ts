import type { Db } from "../Db.js";
import { now, valuesList } from "../Db.js";
import { mergePendingNotes } from "./albumNotes.js";

/**
 * What a library file asked for that waits on an album, track or artist arriving here
 * (table import_pending, migration 0007). Rows go in with INSERT OR IGNORE on their natural
 * key and are resolved by resolvePending() with set-based statements: insert what now
 * resolves, then delete the rows that are satisfied. Every step is safe to repeat, so an
 * interruption anywhere leaves at worst a row that the next resolve finishes.
 */
export type PendingRow =
  | { kind: "playlist_track"; playlist_id: number; position: number; album_url: string; track_bcid: number | null; track_num: number | null; track_title: string }
  | { kind: "play"; album_url: string; track_bcid: number | null; track_num: number | null; track_title: string; played_at: string; seconds: number }
  | { kind: "mute"; band_id: number }
  | { kind: "dismissed"; band_id: number; release_url: string; item_type: string; title: string; art_id: number | null; artist_override: string | null };

const COLS = [
  "kind", "dedupe_key", "playlist_id", "position", "album_url", "track_bcid", "track_num", "track_title",
  "played_at", "seconds", "band_id", "release_url", "item_type", "title", "art_id", "artist_override",
] as const;

function dedupeKey(r: PendingRow): string {
  switch (r.kind) {
    case "playlist_track": return `pl:${r.playlist_id}:${r.position}`;
    case "play": return `play:${r.track_bcid ?? ""}:${r.album_url}:${r.track_num ?? ""}:${r.track_title}:${r.played_at}`;
    case "mute": return `mute:${r.band_id}`;
    case "dismissed": return `dis:${r.release_url}`;
  }
}

/** Queue rows; ones already waiting (same natural key) are left alone. */
export async function addPending(db: Db, rows: PendingRow[]): Promise<void> {
  // 500 rows x 16 columns stays well under SQLite's 32766 bound parameters.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params = chunk.flatMap((r) => {
      const o = r as unknown as Record<string, unknown>;
      return COLS.map((c) => (c === "dedupe_key" ? dedupeKey(r) : o[c] ?? null));
    });
    await db.run(`INSERT OR IGNORE INTO import_pending (${COLS.join(", ")}) VALUES ${valuesList(chunk.length, COLS.length)}`, params);
  }
}

/** The library track a pending row means: by Bandcamp track id, else by album URL, number and title. */
const TID = `COALESCE(
  (SELECT t.id FROM tracks t WHERE t.track_id = p.track_bcid),
  (SELECT t.id FROM tracks t JOIN albums a ON a.id = t.album_id
   WHERE a.url = p.album_url AND t.title = p.track_title AND (p.track_num IS NULL OR t.track_num = p.track_num) ORDER BY t.id LIMIT 1))`;

/**
 * Write everything that can be written now, then forget it. Cheap when nothing waits.
 * With `albumId` (the album an import job item just wrote) only rows that can concern that
 * album are looked at: its URL or one of its tracks, and its artist. Without it, every row
 * (the end of a job, and right after an import starts). Returns how many playlist entries
 * and plays were added.
 */
export async function resolvePending(db: Db, albumId?: number): Promise<{ tracks: number; plays: number }> {
  await mergePendingNotes(db, albumId); // album notes wait in their own table (#73)
  if (!(await db.get("SELECT 1 AS x FROM import_pending LIMIT 1"))) return { tracks: 0, plays: 0 };
  let T = "";
  let tp: unknown[] = [];
  let A = "";
  let ap: unknown[] = [];
  if (albumId !== undefined) {
    const a = await db.get<{ url: string; band_id: number }>(
      "SELECT a.url, ar.band_id FROM albums a JOIN artists ar ON ar.id = a.artist_id WHERE a.id = ?", [albumId]);
    if (!a) return { tracks: 0, plays: 0 };
    T = "AND (p.album_url = ? OR p.track_bcid IN (SELECT track_id FROM tracks WHERE album_id = ?))";
    tp = [a.url, albumId];
    A = "AND p.band_id = ?";
    ap = [a.band_id];
  }
  // Playlist entries, at their original positions (the playlist was created empty for them).
  const tracks = (await db.run(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position)
     SELECT r.playlist_id, r.tid, r.position FROM (SELECT p.playlist_id, p.position, ${TID} AS tid FROM import_pending p WHERE p.kind = 'playlist_track' ${T}) r
     WHERE r.tid IS NOT NULL AND EXISTS (SELECT 1 FROM playlists pl WHERE pl.id = r.playlist_id)
       AND NOT EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.playlist_id = r.playlist_id AND x.position = r.position AND x.track_id = r.tid)
     GROUP BY r.playlist_id, r.position ORDER BY r.playlist_id, r.position`,
    tp,
  )).changes;
  const DONE = `EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.playlist_id = p.playlist_id AND x.position = p.position AND x.track_id = ${TID})`;
  if (tracks) {
    await db.run(
      `UPDATE playlists SET updated_at = ? WHERE id IN (SELECT p.playlist_id FROM import_pending p WHERE p.kind = 'playlist_track' ${T} AND ${DONE})`,
      [now(), ...tp],
    );
  }
  await db.run(
    `DELETE FROM import_pending AS p WHERE p.kind = 'playlist_track' ${T} AND (NOT EXISTS (SELECT 1 FROM playlists pl WHERE pl.id = p.playlist_id) OR ${DONE})`,
    tp,
  );
  // Plays are merged: one already recorded (same track, same moment) is never added twice.
  const plays = (await db.run(
    `INSERT INTO plays (track_id, played_at, seconds_listened)
     SELECT r.tid, r.played_at, MAX(r.seconds) FROM (SELECT ${TID} AS tid, p.played_at, p.seconds FROM import_pending p WHERE p.kind = 'play' ${T}) r
     WHERE r.tid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plays x WHERE x.track_id = r.tid AND x.played_at = r.played_at)
     GROUP BY r.tid, r.played_at ORDER BY r.played_at`,
    tp,
  )).changes;
  await db.run(`DELETE FROM import_pending AS p WHERE p.kind = 'play' ${T} AND EXISTS (SELECT 1 FROM plays x WHERE x.track_id = ${TID} AND x.played_at = p.played_at)`, tp);
  // The album is here with its tracks but this track isn't on it any more: it will never resolve.
  await db.run(
    `DELETE FROM import_pending AS p WHERE p.kind IN ('playlist_track', 'play') ${T} AND ${TID} IS NULL
       AND EXISTS (SELECT 1 FROM albums a WHERE a.url = p.album_url AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id))`,
    tp,
  );
  // New-release preferences, once the artist is in the library.
  await db.run(
    `INSERT INTO release_watch (artist_id, muted)
     SELECT ar.id, 1 FROM import_pending p JOIN artists ar ON ar.band_id = p.band_id WHERE p.kind = 'mute' ${A}
     ON CONFLICT(artist_id) DO UPDATE SET muted = 1`,
    ap,
  );
  await db.run(
    `INSERT INTO artist_releases (artist_id, url, item_type, title, art_id, artist_override, status)
     SELECT ar.id, p.release_url, p.item_type, p.title, p.art_id, p.artist_override, 'dismissed'
     FROM import_pending p JOIN artists ar ON ar.band_id = p.band_id WHERE p.kind = 'dismissed' ${A}
     ON CONFLICT(url) DO UPDATE SET status = 'dismissed' WHERE artist_releases.status = 'new'`,
    ap,
  );
  await db.run(`DELETE FROM import_pending AS p WHERE p.kind IN ('mute', 'dismissed') ${A} AND EXISTS (SELECT 1 FROM artists ar WHERE ar.band_id = p.band_id)`, ap);
  return { tracks, plays };
}

export interface PendingCount { tracks: number; plays: number; other: number; notes: number }

/** How much of an imported library still waits for its albums. */
export async function countPending(db: Db): Promise<PendingCount> {
  const rows = await db.select<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM import_pending GROUP BY kind");
  const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
  const notes = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM album_notes_pending"))?.n ?? 0;
  return { tracks: n("playlist_track"), plays: n("play"), other: n("mute") + n("dismissed"), notes };
}

/** Forget waiting plays (Clear history), so they can't come back when their albums arrive. */
export async function clearPendingPlays(db: Db): Promise<number> {
  return (await db.run("DELETE FROM import_pending WHERE kind = 'play'")).changes;
}

/** Stop waiting: forget everything still pending. */
export async function clearPending(db: Db): Promise<number> {
  const notes = (await db.run("DELETE FROM album_notes_pending")).changes;
  return notes + (await db.run("DELETE FROM import_pending")).changes;
}
