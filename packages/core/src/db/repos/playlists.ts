import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { Playlist, PlaylistWithTracks, PlaylistTrack } from "../../types.js";
import { PLAYLIST_NAME_MAX } from "../../config.js";

export { PLAYLIST_NAME_MAX };

/** Thrown by createPlaylist/renamePlaylist when the name is empty after normalisation. */
export class PlaylistNameError extends Error {
  readonly code = "invalid_playlist_name";
  constructor(message = "Playlist name can't be empty.") {
    super(message);
    this.name = "PlaylistNameError";
  }
}

// Invisible format characters (Cf) other than the ones emoji and some scripts need: ZWNJ,
// ZWJ, and the tag characters U+E0020-E007F that spell out the England/Scotland/Wales flags.
const DROPPED_FORMAT = /[^\P{Cf}\u200c\u200d\u{E0020}-\u{E007F}]/gu;
const KEPT_FORMAT = /[\u200c\u200d\u{E0020}-\u{E007F}]/gu;

/**
 * Trim, collapse runs of control characters (newlines, tabs, ...) and spaces into a
 * single space, and cap at PLAYLIST_NAME_MAX characters. Returns null when nothing
 * is left, so the UI can disable submit with the same rule the repo enforces.
 */
export function normalizePlaylistName(name: string): string | null {
  const clean = String(name ?? "")
    .replace(DROPPED_FORMAT, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp} ]+/gu, " ")
    .trim();
  // A name made only of joiners, tags and spaces is still empty.
  if (!clean.replace(KEPT_FORMAT, "").trim()) return null;
  return graphemes(clean).slice(0, PLAYLIST_NAME_MAX).join("").trimEnd();
}

/** Split into user-perceived characters so the cap never cuts an emoji or accent in half. */
function graphemes(s: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment);
  }
  return Array.from(s);
}

function requireName(name: string): string {
  const n = normalizePlaylistName(name);
  if (!n) throw new PlaylistNameError();
  return n;
}

interface PlaylistRow extends Playlist { art_ids_csv: string | null }

function rowToPlaylist(r: PlaylistRow): Playlist {
  const { art_ids_csv, ...rest } = r;
  const seen = new Set<number>();
  const art_ids: number[] = [];
  for (const s of (art_ids_csv ?? "").split(",")) {
    const n = Number(s);
    if (s && Number.isFinite(n) && !seen.has(n)) { seen.add(n); art_ids.push(n); }
    if (art_ids.length === 4) break;
  }
  return { ...rest, art_ids };
}

const PLAYLIST_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
    (SELECT GROUP_CONCAT(art_id) FROM (
       SELECT al.art_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id
       WHERE pt.playlist_id = p.id AND al.art_id IS NOT NULL ORDER BY pt.position LIMIT 12)) AS art_ids_csv
  FROM playlists p`;

export async function listPlaylists(db: Db): Promise<Playlist[]> {
  return (await db.select<PlaylistRow>(`${PLAYLIST_SELECT} ORDER BY p.updated_at DESC`)).map(rowToPlaylist);
}

export async function createPlaylist(db: Db, name: string): Promise<Playlist> {
  const r = await db.get<{ id: number }>("INSERT INTO playlists (name) VALUES (?) RETURNING id", [requireName(name)]);
  return (await db.get<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.id = ?`, [r!.id]).then((p) => p && rowToPlaylist(p)))!;
}

export async function renamePlaylist(db: Db, id: number, name: string): Promise<boolean> {
  return (await db.run("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?", [requireName(name), now(), id])).changes > 0;
}

export async function deletePlaylist(db: Db, id: number): Promise<boolean> {
  return (await db.run("DELETE FROM playlists WHERE id = ?", [id])).changes > 0;
}

export async function getPlaylist(db: Db, id: number): Promise<PlaylistWithTracks | null> {
  const p = await db.get<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.id = ?`, [id]);
  if (!p) return null;
  const tracks = (
    await db.select<Omit<PlaylistTrack, "streamable"> & { streamable: number }>(
      `SELECT pt.id AS playlist_track_id, pt.position, t.id, t.track_id, t.album_id, t.title, t.track_num, t.duration,
              t.track_artist, t.streamable, t.lyrics, al.title AS album_title, al.url AS album_url, al.art_id, ar.name AS artist_name
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
       JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id
       WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id`,
      [id],
    )
  ).map((t) => ({ ...t, streamable: !!t.streamable }));
  return { ...rowToPlaylist(p), track_count: tracks.length, tracks };
}

/** Append tracks; positions are computed inside the single INSERT so no transaction is needed. */
export async function addTracks(db: Db, playlistId: number, trackIds: number[]): Promise<void> {
  if (!trackIds.length) return;
  // SQLite has no `VALUES ... AS v(cols)`, so build the row set with UNION ALL.
  const rows = trackIds.map((_, i) => (i === 0 ? "SELECT ? AS tid, 0 AS off" : `SELECT ?, ${i}`)).join(" UNION ALL ");
  await db.run(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position)
     SELECT ?, v.tid, (SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?) + 1 + v.off
     FROM (${rows}) AS v`,
    [playlistId, playlistId, ...trackIds],
  );
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
}

/** Rewrite positions in one statement from the given order of playlist_track ids. */
export async function reorder(db: Db, playlistId: number, playlistTrackIds: number[]): Promise<void> {
  if (!playlistTrackIds.length) return;
  const cases = playlistTrackIds.map(() => "WHEN ? THEN ?").join(" ");
  const params: unknown[] = [];
  playlistTrackIds.forEach((ptid, i) => params.push(ptid, i));
  await db.run(
    `UPDATE playlist_tracks SET position = CASE id ${cases} ELSE position END WHERE playlist_id = ? AND id IN (${playlistTrackIds.map(() => "?").join(",")})`,
    [...params, playlistId, ...playlistTrackIds],
  );
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
}

export async function removeTrack(db: Db, playlistId: number, playlistTrackId: number): Promise<boolean> {
  const r = await db.run("DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?", [playlistTrackId, playlistId]);
  if (r.changes > 0) await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
  return r.changes > 0;
}

/** Which of the given playlists already contain ALL of the given tracks (for check marks). */
export async function playlistsContaining(db: Db, trackIds: number[]): Promise<Set<number>> {
  if (!trackIds.length) return new Set();
  const rows = await db.select<{ playlist_id: number }>(
    `SELECT playlist_id FROM playlist_tracks WHERE track_id IN (${trackIds.map(() => "?").join(",")})
     GROUP BY playlist_id HAVING COUNT(DISTINCT track_id) = ?`,
    [...trackIds, trackIds.length],
  );
  return new Set(rows.map((r) => r.playlist_id));
}
