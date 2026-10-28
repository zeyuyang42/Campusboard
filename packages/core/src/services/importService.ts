import type { Db } from "../db/Db.js";
import { chunks, now, placeholders, valuesList } from "../db/Db.js";
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
 *
 * vacuumOrphans runs only when this write can have left orphans behind (tracks that left
 * another album or were dropped from this one, an album that changed artist), so a stream
 * URL refresh on the play path costs no sweep; the job runner sweeps once per job as well.
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
  // A release that moved to another band page leaves its old artist, maybe with nothing else.
  const prev = await db.get<{ artist_id: number }>("SELECT artist_id FROM albums WHERE item_type = ? AND bandcamp_id = ?", [p.item_type, p.bandcamp_id]);
  let orphans = !!prev && prev.artist_id !== artistId;
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

  const ids = p.tracks.map((t) => t.track_id);
  // A track that lives in another album so far (a single's pseudo-album, when the album comes
  // in) moves here below and leaves that album behind.
  for (const chunk of chunks(ids, 500)) {
    if (orphans) break;
    orphans = !!(await db.get(`SELECT 1 AS x FROM tracks WHERE album_id != ? AND track_id IN (${placeholders(chunk.length)}) LIMIT 1`, [albumId, ...chunk]));
  }

  const COLS = 11;
  for (const chunk of chunks(p.tracks, 100)) {
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
    const r = await db.run(`DELETE FROM tracks WHERE album_id = ? ${ids.length ? `AND track_id NOT IN (${placeholders(ids.length)})` : ""}`, [albumId, ...ids]);
    orphans ||= r.changes > 0;
  }
  if (orphans) await vacuumOrphans(db);
  return albumId;
}

/**
 * Remove single-track pseudo-albums whose track moved into a real album, artists with nothing
 * left, plays of tracks that are gone, new-release rows of artists that are gone, import
 * bookkeeping of playlists that are gone, notes of albums that are gone, resume points of tracks that are gone and rules of smart playlists that are gone (the foreign keys cascade those; this also catches
 * deletes made with foreign keys off, e.g. the sqlite3 CLI).
 */
export async function vacuumOrphans(db: Db): Promise<void> {
  await db.run("DELETE FROM albums WHERE item_type = 'track' AND id NOT IN (SELECT DISTINCT album_id FROM tracks)");
  await db.run("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
  await db.run("DELETE FROM plays WHERE track_id NOT IN (SELECT id FROM tracks)");
  await db.run("DELETE FROM release_watch WHERE artist_id NOT IN (SELECT id FROM artists)");
  await db.run("DELETE FROM artist_releases WHERE artist_id NOT IN (SELECT id FROM artists)");
  await db.run("DELETE FROM imported_playlists WHERE playlist_id NOT IN (SELECT id FROM playlists)");
  // A pseudo-album removed above takes its note and rating with it, like any deleted album
  // (rare: a single rated before its album was imported).
  await db.run("DELETE FROM album_notes WHERE album_id NOT IN (SELECT id FROM albums)");
  await db.run("DELETE FROM import_pending WHERE playlist_id IS NOT NULL AND playlist_id NOT IN (SELECT id FROM playlists)");
  // Resume points (#85) have no foreign key (radio episodes use negative ids): a library
  // track's goes with the track, so a reused id never resumes another track.
  await db.run("DELETE FROM resume_positions WHERE item_id > 0 AND item_id NOT IN (SELECT id FROM tracks)");
  // Smart playlist rules (#84) go with their playlist.
  await db.run("DELETE FROM smart_playlists WHERE playlist_id NOT IN (SELECT id FROM playlists)");
  // Archive marks and crate memberships (#126) go with their album; a crate's bookkeeping with the crate.
  await db.run("DELETE FROM album_archive WHERE album_id NOT IN (SELECT id FROM albums)");
  await db.run("DELETE FROM crate_albums WHERE album_id NOT IN (SELECT id FROM albums) OR crate_id NOT IN (SELECT id FROM crates)");
  await db.run("DELETE FROM crate_albums_pending WHERE crate_id NOT IN (SELECT id FROM crates)");
  await db.run("DELETE FROM imported_crates WHERE crate_id NOT IN (SELECT id FROM crates)");
}

async function updateStreamFields(db: Db, p: ParsedTralbum) {
  for (const t of p.tracks) {
    await db.run("UPDATE tracks SET streamable = ?, stream_url = ?, stream_quality = ?, stream_expires_at = ? WHERE track_id = ?", [t.streamable ? 1 : 0, t.stream_url, t.stream_quality, t.stream_expires_at, t.track_id]);
  }
}
