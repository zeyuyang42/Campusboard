import type { Db } from "../connection.js";
import type { Album, AlbumWithTracks, Track } from "@bc/shared";

export interface AlbumRow extends Omit<Album, "tags" | "is_preorder" | "owned"> {
  tags_json: string;
  is_preorder: number;
  owned: number;
}

export function rowToAlbum(r: AlbumRow): Album {
  return { ...r, tags: JSON.parse(r.tags_json || "[]"), is_preorder: !!r.is_preorder, owned: !!r.owned };
}

const ALBUM_SELECT = `
  SELECT al.*, ar.name AS artist_name,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
    (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND t.streamable = 1) AS streamable_count
  FROM albums al JOIN artists ar ON ar.id = al.artist_id`;

export type AlbumSort = "added" | "artist" | "release" | "title";
const SORTS: Record<AlbumSort, string> = {
  added: "al.created_at DESC, al.id DESC",
  artist: "ar.name COLLATE NOCASE, al.release_date DESC",
  release: "al.release_date DESC, al.title",
  title: "al.title COLLATE NOCASE",
};

export function listAlbums(db: Db, sort: AlbumSort = "added"): Album[] {
  return (db.prepare(`${ALBUM_SELECT} ORDER BY ${SORTS[sort] ?? SORTS.added}`).all() as unknown as AlbumRow[]).map(rowToAlbum);
}

export function getAlbum(db: Db, id: number): Album | null {
  const r = db.prepare(`${ALBUM_SELECT} WHERE al.id = ?`).get(id) as unknown as AlbumRow | undefined;
  return r ? rowToAlbum(r) : null;
}

export function getAlbumByUrl(db: Db, url: string): Album | null {
  const r = db.prepare(`${ALBUM_SELECT} WHERE al.url = ?`).get(url) as unknown as AlbumRow | undefined;
  return r ? rowToAlbum(r) : null;
}

export function getAlbumWithTracks(db: Db, id: number): AlbumWithTracks | null {
  const album = getAlbum(db, id);
  if (!album) return null;
  const tracks = db
    .prepare(
      `SELECT id, track_id, album_id, title, track_num, duration, track_artist, streamable, lyrics
       FROM tracks WHERE album_id = ? ORDER BY track_num, id`,
    )
    .all(id) as unknown as (Omit<Track, "streamable"> & { streamable: number })[];
  return {
    ...album,
    tracks: tracks.map((t) => ({ ...t, streamable: !!t.streamable, album_title: album.title, artist_name: album.artist_name, art_id: album.art_id, album_url: album.url })),
  };
}

export function deleteAlbum(db: Db, id: number): boolean {
  const r = db.prepare("DELETE FROM albums WHERE id = ?").run(id);
  db.exec("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
  return r.changes > 0;
}

export function albumUrlsInLibrary(db: Db): Set<string> {
  return new Set((db.prepare("SELECT url FROM albums").all() as { url: string }[]).map((r) => r.url));
}
