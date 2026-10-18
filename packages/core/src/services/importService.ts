import type { Db } from "../db/Db.js";
import { now, valuesList } from "../db/Db.js";
import { upsertArtist } from "../db/repos/artists.js";
import { undismiss } from "../db/repos/fanItems.js";
import type { ParsedTralbum } from "../scrape/parseTralbum.js";

/**
 * Idempotently write a parsed album/track page into the library and return the
 * library album id that now holds the tracks.
 *
 * There is no transaction (the SQL plugin pools connections), so the statements
 * are ordered such that an interruption at any point leaves a consistent library:
 * parents before children, deletes last, and every step safe to repeat.
 */
export async function upsertTralbum(db: Db, p: ParsedTralbum): Promise<number> {
  // A single-track page whose track already lives in a real album: only refresh stream info.
  if (p.item_type === "track" && p.tracks.length === 1) {
    const existing = await db.get<{ id: number; album_id: number; item_type: string }>(
      "SELECT t.id, t.album_id, al.item_type FROM tracks t JOIN albums al ON al.id = t.album_id WHERE t.track_id = ?",
      [p.tracks[0].track_id],
    );
    if (existing && existing.item_type === "album") {
      await updateStreamFields(db, p);
      return existing.album_id;
    }
  }

  const artistId = await upsertArtist(db, p.artist);
  // `owned` follows the synced collection (fan_items), so any import of a purchased release is flagged.
  const album = await db.get<{ id: number }>(
    `INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, art_id, release_date, about, credits, tags_json, is_preorder, fetched_at, owned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       EXISTS (SELECT 1 FROM fan_items f WHERE f.list = 'collection' AND f.item_type = ? AND f.bandcamp_id = ?))
     ON CONFLICT(item_type, bandcamp_id) DO UPDATE SET
       artist_id = excluded.artist_id, title = excluded.title, url = excluded.url, art_id = excluded.art_id,
       release_date = excluded.release_date, about = excluded.about, credits = excluded.credits,
       tags_json = excluded.tags_json, is_preorder = excluded.is_preorder, fetched_at = excluded.fetched_at,
       owned = excluded.owned
     RETURNING id`,
    [p.bandcamp_id, p.item_type, artistId, p.title, p.url, p.art_id, p.release_date, p.about, p.credits, JSON.stringify(p.tags), p.is_preorder ? 1 : 0, now(), p.item_type, p.bandcamp_id],
  );
  const albumId = album!.id;
  await undismiss(db, p.item_type, p.bandcamp_id, p.tracks.map((t) => t.track_id));

  const COLS = 11;
  for (let i = 0; i < p.tracks.length; i += 100) {
    const chunk = p.tracks.slice(i, i + 100);
    await db.run(
      `INSERT INTO tracks (track_id, album_id, title, track_num, duration, track_artist, streamable, stream_url, stream_quality, stream_expires_at, lyrics)
       VALUES ${valuesList(chunk.length, COLS)}
       ON CONFLICT(track_id) DO UPDATE SET
         album_id = excluded.album_id, title = excluded.title, track_num = excluded.track_num, duration = excluded.duration,
         track_artist = excluded.track_artist, streamable = excluded.streamable, stream_url = excluded.stream_url,
         stream_quality = excluded.stream_quality, stream_expires_at = excluded.stream_expires_at, lyrics = excluded.lyrics`,
      chunk.flatMap((t) => [t.track_id, albumId, t.title, t.track_num, t.duration, t.artist, t.streamable ? 1 : 0, t.stream_url, t.stream_quality, t.stream_expires_at, t.lyrics]),
    );
  }

  if (p.item_type === "album") {
    const ids = p.tracks.map((t) => t.track_id);
    await db.run(`DELETE FROM tracks WHERE album_id = ? ${ids.length ? `AND track_id NOT IN (${ids.map(() => "?").join(",")})` : ""}`, [albumId, ...ids]);
  }
  await vacuumOrphans(db);
  return albumId;
}

/**
 * Remove single-track pseudo-albums whose track moved into a real album, artists with nothing
 * left, plays of tracks that are gone, new-release rows of artists that are gone and import
 * bookkeeping of playlists that are gone (the foreign keys cascade those; this also catches
 * deletes made with foreign keys off, e.g. the sqlite3 CLI).
 */
export async function vacuumOrphans(db: Db): Promise<void> {
  await db.run("DELETE FROM albums WHERE item_type = 'track' AND id NOT IN (SELECT DISTINCT album_id FROM tracks)");
  await db.run("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
  await db.run("DELETE FROM plays WHERE track_id NOT IN (SELECT id FROM tracks)");
  await db.run("DELETE FROM release_watch WHERE artist_id NOT IN (SELECT id FROM artists)");
  await db.run("DELETE FROM artist_releases WHERE artist_id NOT IN (SELECT id FROM artists)");
  await db.run("DELETE FROM imported_playlists WHERE playlist_id NOT IN (SELECT id FROM playlists)");
  await db.run("DELETE FROM import_pending WHERE playlist_id IS NOT NULL AND playlist_id NOT IN (SELECT id FROM playlists)");
}

async function updateStreamFields(db: Db, p: ParsedTralbum) {
  for (const t of p.tracks) {
    await db.run("UPDATE tracks SET streamable = ?, stream_url = ?, stream_quality = ?, stream_expires_at = ? WHERE track_id = ?", [t.streamable ? 1 : 0, t.stream_url, t.stream_quality, t.stream_expires_at, t.track_id]);
  }
}
