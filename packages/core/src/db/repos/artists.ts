import type { Db } from "../Db.js";
import type { Artist, Album } from "../../types.js";
import { rowToAlbum, RELEASE_KEY, type AlbumRow } from "./albums.js";

export async function upsertArtist(db: Db, a: { band_id: number; name: string; url: string; location?: string | null }): Promise<number> {
  const row = await db.get<{ id: number }>(
    `INSERT INTO artists (band_id, name, url, location) VALUES (?, ?, ?, ?)
     ON CONFLICT(band_id) DO UPDATE SET name = excluded.name, url = excluded.url,
       location = COALESCE(excluded.location, artists.location)
     RETURNING id`,
    [a.band_id, a.name, a.url, a.location ?? null],
  );
  return row!.id;
}

export function listArtists(db: Db): Promise<Artist[]> {
  return db.select<Artist>(
    `SELECT ar.*, (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count
     FROM artists ar WHERE album_count > 0 ORDER BY ar.name COLLATE NOCASE`,
  );
}

export async function getArtist(db: Db, id: number): Promise<(Artist & { albums: Album[] }) | null> {
  const ar = await db.get<Artist>("SELECT * FROM artists WHERE id = ?", [id]);
  if (!ar) return null;
  const rows = await db.select<AlbumRow>(
    `SELECT al.*, ar.name AS artist_name,
       (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
       (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count
     FROM albums al JOIN artists ar ON ar.id = al.artist_id
     WHERE al.artist_id = ? ORDER BY ${RELEASE_KEY} DESC, al.title COLLATE NOCASE, al.id`,
    [id],
  );
  return { ...ar, albums: rows.map(rowToAlbum) };
}
