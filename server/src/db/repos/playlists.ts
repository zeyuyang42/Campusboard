import type { Db } from "../connection.js";
import { tx, now } from "../connection.js";
import type { Playlist, PlaylistWithTracks, PlaylistTrack } from "@bc/shared";

export function listPlaylists(db: Db): Playlist[] {
  return db
    .prepare(`SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count FROM playlists p ORDER BY p.updated_at DESC`)
    .all() as unknown as Playlist[];
}

export function createPlaylist(db: Db, name: string): Playlist {
  return db.prepare("INSERT INTO playlists (name) VALUES (?) RETURNING *").get(name) as unknown as Playlist;
}

export function renamePlaylist(db: Db, id: number, name: string): boolean {
  return db.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id).changes > 0;
}

export function deletePlaylist(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM playlists WHERE id = ?").run(id).changes > 0;
}

export function getPlaylist(db: Db, id: number): PlaylistWithTracks | null {
  const p = db.prepare("SELECT * FROM playlists WHERE id = ?").get(id) as unknown as Playlist | undefined;
  if (!p) return null;
  const tracks = (
    db
      .prepare(
        `SELECT pt.id AS playlist_track_id, pt.position, t.id, t.track_id, t.album_id, t.title, t.track_num, t.duration,
                t.track_artist, t.streamable, t.lyrics, al.title AS album_title, al.url AS album_url, al.art_id, ar.name AS artist_name
         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id
         WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id`,
      )
      .all(id) as unknown as (Omit<PlaylistTrack, "streamable"> & { streamable: number })[]
  ).map((t) => ({ ...t, streamable: !!t.streamable }));
  return { ...p, track_count: tracks.length, tracks };
}

export function addTracks(db: Db, playlistId: number, trackIds: number[]): void {
  tx(db, () => {
    const max = (db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as { m: number }).m;
    const ins = db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)");
    trackIds.forEach((tid, i) => ins.run(playlistId, tid, max + 1 + i));
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
  });
}

export function reorder(db: Db, playlistId: number, playlistTrackIds: number[]): void {
  tx(db, () => {
    const upd = db.prepare("UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?");
    playlistTrackIds.forEach((ptid, i) => upd.run(i, ptid, playlistId));
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
  });
}

export function removeTrack(db: Db, playlistId: number, playlistTrackId: number): boolean {
  const r = db.prepare("DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?").run(playlistTrackId, playlistId);
  if (r.changes > 0) db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now(), playlistId);
  return r.changes > 0;
}
