import type { Db } from "../connection.js";
import type { Artist, Album } from "@bc/shared";
import { rowToAlbum, type AlbumRow } from "./albums.js";

export function upsertArtist(db: Db, a: { band_id: number; name: string; url: string; location?: string | null }): number {
  const row = db
    .prepare(
      `INSERT INTO artists (band_id, name, url, location) VALUES (?, ?, ?, ?)
       ON CONFLICT(band_id) DO UPDATE SET name = excluded.name, url = excluded.url,
         location = COALESCE(excluded.location, artists.location)
       RETURNING id`,
    )
    .get(a.band_id, a.name, a.url, a.location ?? null) as { id: number };
  return row.id;
}

export function listArtists(db: Db): Artist[] {
  return db
    .prepare(
      `SELECT ar.*, (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count
       FROM artists ar WHERE album_count > 0 ORDER BY ar.name COLLATE NOCASE`,
    )
    .all() as unknown as Artist[];
}

export function getArtist(db: Db, id: number): (Artist & { albums: Album[] }) | null {
  const ar = db.prepare("SELECT * FROM artists WHERE id = ?").get(id) as unknown as Artist | undefined;
  if (!ar) return null;
  const albums = (
    db
      .prepare(
        `SELECT al.*, ar.name AS artist_name,
           (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
           (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count
         FROM albums al JOIN artists ar ON ar.id = al.artist_id
         WHERE al.artist_id = ? ORDER BY al.release_date DESC, al.title`,
      )
      .all(id) as unknown as AlbumRow[]
  ).map(rowToAlbum);
  return { ...ar, albums };
}
