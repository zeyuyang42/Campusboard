import type { Db } from "../Db.js";
import type { Album, AlbumWithTracks, Track } from "../../types.js";

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

export async function listAlbums(db: Db, sort: AlbumSort = "added"): Promise<Album[]> {
  return (await db.select<AlbumRow>(`${ALBUM_SELECT} ORDER BY ${SORTS[sort] ?? SORTS.added}`)).map(rowToAlbum);
}

export async function getAlbum(db: Db, id: number): Promise<Album | null> {
  const r = await db.get<AlbumRow>(`${ALBUM_SELECT} WHERE al.id = ?`, [id]);
  return r ? rowToAlbum(r) : null;
}

export async function getAlbumWithTracks(db: Db, id: number): Promise<AlbumWithTracks | null> {
  const album = await getAlbum(db, id);
  if (!album) return null;
  const tracks = await db.select<Omit<Track, "streamable"> & { streamable: number }>(
    `SELECT id, track_id, album_id, title, track_num, duration, track_artist, streamable, lyrics
     FROM tracks WHERE album_id = ? ORDER BY track_num, id`,
    [id],
  );
  return {
    ...album,
    tracks: tracks.map((t) => ({ ...t, streamable: !!t.streamable, album_title: album.title, artist_name: album.artist_name, art_id: album.art_id, album_url: album.url })),
  };
}

export async function deleteAlbum(db: Db, id: number): Promise<boolean> {
  const r = await db.run("DELETE FROM albums WHERE id = ?", [id]);
  await db.run("DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM albums)");
  return r.changes > 0;
}

export async function albumUrlsInLibrary(db: Db): Promise<Set<string>> {
  return new Set((await db.select<{ url: string }>("SELECT url FROM albums")).map((r) => r.url));
}

export async function artistUrlsInLibrary(db: Db): Promise<Set<string>> {
  return new Set((await db.select<{ url: string }>("SELECT url FROM artists")).map((r) => r.url));
}
