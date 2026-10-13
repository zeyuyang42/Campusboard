import type { Db } from "../db/connection.js";
import { tx, now } from "../db/connection.js";
import { upsertArtist } from "../db/repos/artists.js";
import type { ParsedTralbum } from "../scrape/parseTralbum.js";

/**
 * Idempotently write a parsed album/track page into the library.
 * Returns the library album id that now holds the tracks.
 */
export function upsertTralbum(db: Db, p: ParsedTralbum): number {
  return tx(db, () => {
    // A single-track page whose track already lives in a real album: only refresh stream info.
    if (p.item_type === "track" && p.tracks.length === 1) {
      const existing = db
        .prepare("SELECT t.id, t.album_id, al.item_type FROM tracks t JOIN albums al ON al.id = t.album_id WHERE t.track_id = ?")
        .get(p.tracks[0].track_id) as { id: number; album_id: number; item_type: string } | undefined;
      if (existing && existing.item_type === "album") {
        updateStreamFields(db, p);
        return existing.album_id;
      }
    }

    const artistId = upsertArtist(db, p.artist);
    const album = db
      .prepare(
        `INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, art_id, release_date, about, credits, tags_json, is_preorder, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_type, bandcamp_id) DO UPDATE SET
           artist_id = excluded.artist_id, title = excluded.title, url = excluded.url, art_id = excluded.art_id,
           release_date = excluded.release_date, about = excluded.about, credits = excluded.credits,
           tags_json = excluded.tags_json, is_preorder = excluded.is_preorder, fetched_at = excluded.fetched_at
         RETURNING id`,
      )
      .get(p.bandcamp_id, p.item_type, artistId, p.title, p.url, p.art_id, p.release_date, p.about, p.credits, JSON.stringify(p.tags), p.is_preorder ? 1 : 0, now()) as { id: number };

    const ins = db.prepare(
      `INSERT INTO tracks (track_id, album_id, title, track_num, duration, track_artist, streamable, stream_url, stream_expires_at, lyrics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         album_id = excluded.album_id, title = excluded.title, track_num = excluded.track_num, duration = excluded.duration,
         track_artist = excluded.track_artist, streamable = excluded.streamable, stream_url = excluded.stream_url,
         stream_expires_at = excluded.stream_expires_at, lyrics = excluded.lyrics`,
    );
    for (const t of p.tracks) {
      ins.run(t.track_id, album.id, t.title, t.track_num, t.duration, t.artist, t.streamable ? 1 : 0, t.stream_url, t.stream_expires_at, t.lyrics);
    }
    // Drop tracks that disappeared from the page (only meaningful for full albums).
    if (p.item_type === "album") {
      const ids = p.tracks.map((t) => t.track_id);
      db.prepare(`DELETE FROM tracks WHERE album_id = ? ${ids.length ? `AND track_id NOT IN (${ids.map(() => "?").join(",")})` : ""}`).run(album.id, ...ids);
    }
    // Remove single-track pseudo-albums whose track got re-parented into a real album.
    db.exec("DELETE FROM albums WHERE item_type = 'track' AND id NOT IN (SELECT DISTINCT album_id FROM tracks)");
    db.exec("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
    return album.id;
  });
}

function updateStreamFields(db: Db, p: ParsedTralbum) {
  const upd = db.prepare("UPDATE tracks SET streamable = ?, stream_url = ?, stream_expires_at = ? WHERE track_id = ?");
  for (const t of p.tracks) upd.run(t.streamable ? 1 : 0, t.stream_url, t.stream_expires_at, t.track_id);
}
