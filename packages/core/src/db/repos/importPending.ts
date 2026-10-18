import type { Db } from "../Db.js";
import { now, valuesList } from "../Db.js";

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
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
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
 * Returns how many playlist entries and plays were added.
 */
export async function resolvePending(db: Db): Promise<{ tracks: number; plays: number }> {
  if (!(await db.get("SELECT 1 AS x FROM import_pending LIMIT 1"))) return { tracks: 0, plays: 0 };
  // Playlist entries, at their original positions (the playlist was created empty for them).
  const tracks = (await db.run(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position)
     SELECT r.playlist_id, r.tid, r.position FROM (SELECT p.playlist_id, p.position, ${TID} AS tid FROM import_pending p WHERE p.kind = 'playlist_track') r
     WHERE r.tid IS NOT NULL AND EXISTS (SELECT 1 FROM playlists pl WHERE pl.id = r.playlist_id)
       AND NOT EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.playlist_id = r.playlist_id AND x.position = r.position AND x.track_id = r.tid)
     GROUP BY r.playlist_id, r.position ORDER BY r.playlist_id, r.position`,
  )).changes;
  if (tracks) {
    await db.run(
      `UPDATE playlists SET updated_at = ? WHERE id IN (SELECT p.playlist_id FROM import_pending p WHERE p.kind = 'playlist_track' AND EXISTS
         (SELECT 1 FROM playlist_tracks x WHERE x.playlist_id = p.playlist_id AND x.position = p.position AND x.track_id = ${TID}))`,
      [now()],
    );
  }
  await db.run(
    `DELETE FROM import_pending AS p WHERE p.kind = 'playlist_track' AND (NOT EXISTS (SELECT 1 FROM playlists pl WHERE pl.id = p.playlist_id)
       OR EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.playlist_id = p.playlist_id AND x.position = p.position AND x.track_id = ${TID}))`,
  );
  // Plays are merged: one already recorded (same track, same moment) is never added twice.
  const plays = (await db.run(
    `INSERT INTO plays (track_id, played_at, seconds_listened)
     SELECT r.tid, r.played_at, MAX(r.seconds) FROM (SELECT ${TID} AS tid, p.played_at, p.seconds FROM import_pending p WHERE p.kind = 'play') r
     WHERE r.tid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plays x WHERE x.track_id = r.tid AND x.played_at = r.played_at)
     GROUP BY r.tid, r.played_at ORDER BY r.played_at`,
  )).changes;
  await db.run(`DELETE FROM import_pending AS p WHERE p.kind = 'play' AND EXISTS (SELECT 1 FROM plays x WHERE x.track_id = ${TID} AND x.played_at = p.played_at)`);
  // The album is here with its tracks but this track isn't on it any more: it will never resolve.
  await db.run(
    `DELETE FROM import_pending AS p WHERE p.kind IN ('playlist_track', 'play') AND ${TID} IS NULL
       AND EXISTS (SELECT 1 FROM albums a WHERE a.url = p.album_url AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id))`,
  );
  // New-release preferences, once the artist is in the library.
  await db.run(
    `INSERT INTO release_watch (artist_id, muted)
     SELECT ar.id, 1 FROM import_pending p JOIN artists ar ON ar.band_id = p.band_id WHERE p.kind = 'mute'
     ON CONFLICT(artist_id) DO UPDATE SET muted = 1`,
  );
  await db.run(
    `INSERT INTO artist_releases (artist_id, url, item_type, title, art_id, artist_override, status)
     SELECT ar.id, p.release_url, p.item_type, p.title, p.art_id, p.artist_override, 'dismissed'
     FROM import_pending p JOIN artists ar ON ar.band_id = p.band_id WHERE p.kind = 'dismissed'
     ON CONFLICT(url) DO UPDATE SET status = 'dismissed' WHERE artist_releases.status = 'new'`,
  );
  await db.run("DELETE FROM import_pending AS p WHERE p.kind IN ('mute', 'dismissed') AND EXISTS (SELECT 1 FROM artists ar WHERE ar.band_id = p.band_id)");
  return { tracks, plays };
}

export interface PendingCount { tracks: number; plays: number; other: number }

/** How much of an imported library still waits for its albums. */
export async function countPending(db: Db): Promise<PendingCount> {
  const rows = await db.select<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM import_pending GROUP BY kind");
  const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
  return { tracks: n("playlist_track"), plays: n("play"), other: n("mute") + n("dismissed") };
}

/** Stop waiting: forget everything still pending. */
export async function clearPending(db: Db): Promise<number> {
  return (await db.run("DELETE FROM import_pending")).changes;
}
