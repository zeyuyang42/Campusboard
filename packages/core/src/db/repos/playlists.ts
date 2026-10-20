import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { Playlist, PlaylistWithTracks, PlaylistTrack } from "../../types.js";
import { PLAYLIST_NAME_MAX } from "../../config.js";
import { evaluateSmartRule, parseRuleJson, requireRule, summarizeSmartRule } from "./smartPlaylists.js";

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

interface PlaylistRow extends Omit<Playlist, "smart" | "rule"> { art_ids_csv: string | null; rule_json: string | null }

function rowToPlaylist(r: PlaylistRow): Playlist {
  const { art_ids_csv, rule_json, ...rest } = r;
  const seen = new Set<number>();
  const art_ids: number[] = [];
  for (const s of (art_ids_csv ?? "").split(",")) {
    const n = Number(s);
    if (s && Number.isFinite(n) && !seen.has(n)) { seen.add(n); art_ids.push(n); }
    if (art_ids.length === 4) break;
  }
  return { ...rest, art_ids, smart: rule_json !== null, rule: parseRuleJson(rule_json) };
}

/** A smart playlist's count and cover come from its rule as it evaluates now (#84). */
async function withSmartSummary(db: Db, p: Playlist): Promise<Playlist> {
  if (!p.smart) return p;
  return { ...p, ...(p.rule ? await summarizeSmartRule(db, p.rule) : { track_count: 0, art_ids: [] }) };
}

const PLAYLIST_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
    (SELECT GROUP_CONCAT(art_id) FROM (
       SELECT al.art_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id
       WHERE pt.playlist_id = p.id AND al.art_id IS NOT NULL ORDER BY pt.position LIMIT 12)) AS art_ids_csv,
    (SELECT s.rule_json FROM smart_playlists s WHERE s.playlist_id = p.id) AS rule_json
  FROM playlists p`;

/**
 * Every playlist, most recently changed first. A smart playlist's track_count and art_ids
 * come from evaluating its rule, a query each, so only with `summaries` (the Playlists
 * page); otherwise its track_count is undefined and art_ids empty.
 */
export async function listPlaylists(db: Db, opts: { summaries?: boolean } = {}): Promise<Playlist[]> {
  const list = (await db.select<PlaylistRow>(`${PLAYLIST_SELECT} ORDER BY p.updated_at DESC`)).map(rowToPlaylist);
  if (!opts.summaries) return list.map((p) => (p.smart ? { ...p, track_count: undefined, art_ids: [] } : p));
  return Promise.all(list.map((p) => withSmartSummary(db, p)));
}

export async function createPlaylist(db: Db, name: string): Promise<Playlist> {
  const r = await db.get<{ id: number }>("INSERT INTO playlists (name) VALUES (?) RETURNING id", [requireName(name)]);
  return (await db.get<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.id = ?`, [r!.id]).then((p) => p && rowToPlaylist(p)))!;
}

/**
 * Create a smart playlist (#84): the playlist first, its rule second. Interrupted in between,
 * it is left as an ordinary empty playlist, which is readable and can be deleted.
 */
export async function createSmartPlaylist(db: Db, name: string, rule: unknown): Promise<Playlist> {
  const n = requireName(name);
  const r = requireRule(rule);
  const row = await db.get<{ id: number }>("INSERT INTO playlists (name) VALUES (?) RETURNING id", [n]);
  await db.run("INSERT INTO smart_playlists (playlist_id, rule_json) VALUES (?, ?)", [row!.id, JSON.stringify(r)]);
  const p = await db.get<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.id = ?`, [row!.id]);
  return withSmartSummary(db, rowToPlaylist(p!));
}

export async function renamePlaylist(db: Db, id: number, name: string): Promise<boolean> {
  return (await db.run("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?", [requireName(name), now(), id])).changes > 0;
}

export async function deletePlaylist(db: Db, id: number): Promise<boolean> {
  // The rule first (the foreign key would cascade it; this is also right with foreign keys
  // off): interrupted here, an ordinary empty playlist is left.
  await db.run("DELETE FROM smart_playlists WHERE playlist_id = ?", [id]);
  return (await db.run("DELETE FROM playlists WHERE id = ?", [id])).changes > 0;
}

export async function getPlaylist(db: Db, id: number): Promise<PlaylistWithTracks | null> {
  const p = await db.get<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.id = ?`, [id]);
  if (!p) return null;
  const pl = rowToPlaylist(p);
  if (pl.smart) {
    // Evaluated now, never stored; the entry ids are placeholders (nothing to reorder or remove).
    const tracks = pl.rule ? await evaluateSmartRule(db, pl.rule) : [];
    const art = [...new Set(tracks.flatMap((t) => (t.art_id == null ? [] : [t.art_id])))].slice(0, 4);
    return { ...pl, art_ids: art, track_count: tracks.length, tracks: tracks.map((t, i) => ({ ...t, playlist_track_id: -(i + 1), position: i })) };
  }
  const tracks = (
    await db.select<Omit<PlaylistTrack, "streamable" | "downloaded"> & { streamable: number; downloaded: number }>(
      `SELECT pt.id AS playlist_track_id, pt.position, t.id, t.track_id, t.album_id, t.title, t.track_num, t.duration,
              t.track_artist, t.streamable, t.lyrics, al.title AS album_title, al.url AS album_url, al.art_id, ar.name AS artist_name,
              (SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id) AS play_count,
              t.local_path IS NOT NULL AS downloaded
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
       JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id
       WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id`,
      [id],
    )
  ).map((t) => ({ ...t, streamable: !!t.streamable, downloaded: !!t.downloaded }));
  return { ...pl, track_count: tracks.length, tracks };
}

/**
 * Append tracks; positions are computed inside the single INSERT so no transaction is needed.
 * A smart playlist (#84) takes no tracks: the INSERT adds nothing to one.
 * The ids travel as one JSON parameter: no bind-variable or compound-SELECT limit, whatever
 * the count (bulk actions add tens of thousands).
 */
export async function addTracks(db: Db, playlistId: number, trackIds: number[]): Promise<void> {
  if (!trackIds.length) return;
  await db.run(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position)
     SELECT ?, j.value, (SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?) + 1 + j.key
     FROM json_each(?) AS j WHERE NOT EXISTS (SELECT 1 FROM smart_playlists s WHERE s.playlist_id = ?) ORDER BY j.key`,
    [playlistId, playlistId, JSON.stringify(trackIds), playlistId],
  );
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
}

/** Rewrite positions in one statement from the given order of playlist_track ids (one JSON parameter, any length). */
export async function reorder(db: Db, playlistId: number, playlistTrackIds: number[]): Promise<void> {
  if (!playlistTrackIds.length) return;
  await db.run(
    // MATERIALIZED makes the ids the outer loop, each probing playlist_tracks by primary key.
    // As a plain subquery SQLite scans the JSON once per playlist row (minutes at 40k).
    `WITH o AS MATERIALIZED (SELECT j.value AS id, j.key AS pos FROM json_each(?) AS j)
     UPDATE playlist_tracks SET position = o.pos FROM o
     WHERE playlist_tracks.id = o.id AND playlist_tracks.playlist_id = ?`,
    [JSON.stringify(playlistTrackIds), playlistId],
  );
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
}

export async function removeTrack(db: Db, playlistId: number, playlistTrackId: number): Promise<boolean> {
  const r = await db.run("DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?", [playlistTrackId, playlistId]);
  if (r.changes > 0) await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
  return r.changes > 0;
}

/** Which of the given playlists already contain ALL of the given tracks (for check marks). Any number of ids. */
export async function playlistsContaining(db: Db, trackIds: number[]): Promise<Set<number>> {
  if (!trackIds.length) return new Set();
  const ids = JSON.stringify(trackIds);
  const rows = await db.select<{ playlist_id: number }>(
    // IN (subquery) makes SQLite build a temporary index over the ids; playlist_tracks has no
    // index on track_id, so a join driven from the ids would scan it once per id.
    `SELECT playlist_id FROM playlist_tracks WHERE track_id IN (SELECT j.value FROM json_each(?) AS j)
     GROUP BY playlist_id HAVING COUNT(DISTINCT track_id) = (SELECT COUNT(DISTINCT j.value) FROM json_each(?) AS j)`,
    [ids, ids],
  );
  return new Set(rows.map((r) => r.playlist_id));
}

// Undo (#93). A removal takes a snapshot first and hands it to the UI, which gives it back to
// put things where they were. No transactions: each restore is a few ordered statements that
// skip what is already back, and an interruption between them leaves a readable playlist.

/** Playlist entries taken out: enough to put them back where they were. */
export interface RemovedPlaylistTracks {
  playlist_id: number;
  /** `k` is the entry's place (0-based) in the playlist's order when it was removed. */
  rows: { id: number; track_id: number; added_at: string; k: number }[];
}

/** Remove entries and return what was removed (null when nothing was), for restoreTracks. */
export async function removeTracksWithUndo(db: Db, playlistId: number, playlistTrackIds: number[]): Promise<RemovedPlaylistTracks | null> {
  if (!playlistTrackIds.length) return null;
  const ids = JSON.stringify(playlistTrackIds);
  const rows = await db.select<RemovedPlaylistTracks["rows"][number]>(
    `SELECT id, track_id, added_at, k FROM (
       SELECT id, track_id, added_at, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS k FROM playlist_tracks WHERE playlist_id = ?)
     WHERE id IN (SELECT j.value FROM json_each(?) AS j) ORDER BY k`,
    [playlistId, ids],
  );
  if (!rows.length) return null;
  const r = await db.run("DELETE FROM playlist_tracks WHERE playlist_id = ? AND id IN (SELECT j.value FROM json_each(?) AS j)", [playlistId, ids]);
  if (!r.changes) return null;
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), playlistId]);
  return { playlist_id: playlistId, rows };
}

/** The snapshot's rows as a table r(id, track_id, added_at, k, position), from one JSON parameter. */
const SNAP_ROWS = `(SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.track_id') AS track_id,
  json_extract(j.value, '$.added_at') AS added_at, json_extract(j.value, '$.k') AS k, json_extract(j.value, '$.position') AS position
  FROM json_each(?) AS j) r`;

/** An entry of the snapshot is back already: its own id, playlist and track. */
const ALREADY_BACK = "EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.id = r.id AND x.playlist_id = ? AND x.track_id = r.track_id)";

/**
 * Put removed entries back at their places, under their old ids when those are free. Entries
 * whose track has gone since are skipped. Two statements: the rows (with their old place as
 * the position), then one renumbering of the playlist that slots them in; running the whole
 * restore again adds nothing. Returns how many entries came back.
 */
export async function restoreTracks(db: Db, snap: RemovedPlaylistTracks): Promise<number> {
  const pid = snap.playlist_id;
  const json = JSON.stringify(snap.rows);
  const placed = await db.select<{ id: number; k: number }>(
    `INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
     SELECT CASE WHEN EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.id = r.id) THEN NULL ELSE r.id END, ?, r.track_id, r.k, r.added_at
     FROM ${SNAP_ROWS}
     WHERE EXISTS (SELECT 1 FROM playlists p WHERE p.id = ?)
       AND NOT EXISTS (SELECT 1 FROM smart_playlists s WHERE s.playlist_id = ?)
       AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = r.track_id)
       AND NOT ${ALREADY_BACK}
     RETURNING id, position AS k`,
    [pid, json, pid, pid, pid],
  );
  // Back already (the same snapshot restored twice): place the snapshot's own rows again.
  const at = placed.length ? placed : await db.select<{ id: number; k: number }>(`SELECT r.id, r.k FROM ${SNAP_ROWS} WHERE ${ALREADY_BACK}`, [json, pid]);
  if (!at.length) return 0;
  await placeAt(db, pid, at);
  await db.run("UPDATE playlists SET updated_at = ? WHERE id = ?", [now(), pid]);
  return placed.length;
}

/**
 * Renumber a playlist 0..n-1 with the given entries at their places `k` and every other entry
 * in its current order around them. Entry i (in k order) has k_i - i other entries before it,
 * so another entry of rank r ends up i places later for every i with k_i - i <= r. One statement.
 */
async function placeAt(db: Db, playlistId: number, at: { id: number; k: number }[]): Promise<void> {
  await db.run(
    `WITH s AS MATERIALIZED (SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.k') AS k FROM json_each(?) AS j),
     d AS MATERIALIZED (SELECT k - (ROW_NUMBER() OVER (ORDER BY k) - 1) AS d FROM s),
     o AS MATERIALIZED (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS rk FROM playlist_tracks
                        WHERE playlist_id = ? AND id NOT IN (SELECT id FROM s)),
     f AS MATERIALIZED (SELECT id, rk + (SELECT COUNT(*) FROM d WHERE d.d <= o.rk) AS pos FROM o UNION ALL SELECT id, k FROM s)
     UPDATE playlist_tracks SET position = f.pos FROM f WHERE playlist_tracks.id = f.id AND playlist_tracks.playlist_id = ?`,
    [JSON.stringify(at), playlistId, playlistId],
  );
}

/** A deleted playlist: its row, smart rule (#84), entries, and the library-import bookkeeping (#91) that went with it. */
export interface DeletedPlaylist {
  playlist: { id: number; name: string; created_at: string; updated_at: string };
  rule_json: string | null;
  tracks: { id: number; track_id: number; position: number; added_at: string }[];
  /** imported_playlists rows, so importing the same library file again still finds it. */
  imported: { source_key: string; name: string; claimed_at: string }[];
  /** Its import_pending entries, still waiting for their album. */
  pending: { dedupe_key: string; position: number | null; album_url: string | null; track_bcid: number | null; track_num: number | null; track_title: string | null; created_at: string }[];
}

/** Delete a playlist and return what restorePlaylist needs, or null when there was none. */
export async function deletePlaylistWithUndo(db: Db, id: number): Promise<DeletedPlaylist | null> {
  const playlist = await db.get<DeletedPlaylist["playlist"]>("SELECT id, name, created_at, updated_at FROM playlists WHERE id = ?", [id]);
  if (!playlist) return null;
  const rule = await db.get<{ rule_json: string }>("SELECT rule_json FROM smart_playlists WHERE playlist_id = ?", [id]);
  const tracks = await db.select<DeletedPlaylist["tracks"][number]>("SELECT id, track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id", [id]);
  const imported = await db.select<DeletedPlaylist["imported"][number]>("SELECT source_key, name, claimed_at FROM imported_playlists WHERE playlist_id = ?", [id]);
  const pending = await db.select<DeletedPlaylist["pending"][number]>(
    "SELECT dedupe_key, position, album_url, track_bcid, track_num, track_title, created_at FROM import_pending WHERE kind = 'playlist_track' AND playlist_id = ?",
    [id],
  );
  if (!(await deletePlaylist(db, id))) return null;
  return { playlist, rule_json: rule?.rule_json ?? null, tracks, imported, pending };
}

/**
 * Recreate a deleted playlist under its old id when that is still free (its library file key,
 * "<library>:<id>" or the smart key with created_at, is then the same as before), else under a
 * new one. Parent first, then its rule, entries and import bookkeeping; each step skips what
 * is there already, and the playlist itself is found again by id, name and created_at.
 * Returns the playlist's id.
 */
export async function restorePlaylist(db: Db, snap: DeletedPlaylist): Promise<number> {
  const p = snap.playlist;
  const again = await db.get<{ id: number }>("SELECT id FROM playlists WHERE id = ? AND name = ? AND created_at = ?", [p.id, p.name, p.created_at]);
  const id = again?.id ?? (await db.get<{ id: number }>(
    `INSERT INTO playlists (id, name, created_at, updated_at)
     VALUES (CASE WHEN EXISTS (SELECT 1 FROM playlists WHERE id = ?) THEN NULL ELSE ? END, ?, ?, ?) RETURNING id`,
    [p.id, p.id, p.name, p.created_at, p.updated_at],
  ))!.id;
  if (snap.rule_json !== null) await db.run("INSERT OR IGNORE INTO smart_playlists (playlist_id, rule_json) VALUES (?, ?)", [id, snap.rule_json]);
  if (snap.tracks.length) {
    await db.run(
      `INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_at)
       SELECT CASE WHEN EXISTS (SELECT 1 FROM playlist_tracks x WHERE x.id = r.id) THEN NULL ELSE r.id END, ?, r.track_id, r.position, r.added_at
       FROM ${SNAP_ROWS}
       WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.id = r.track_id) AND NOT ${ALREADY_BACK}`,
      [id, JSON.stringify(snap.tracks), id],
    );
  }
  for (const m of snap.imported) {
    await db.run(
      `INSERT INTO imported_playlists (source_key, name, claimed_at, playlist_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET playlist_id = excluded.playlist_id
       WHERE imported_playlists.playlist_id IS NULL OR imported_playlists.playlist_id NOT IN (SELECT id FROM playlists)`,
      [m.source_key, m.name, m.claimed_at, id],
    );
  }
  if (snap.pending.length) {
    await db.run(
      `INSERT OR IGNORE INTO import_pending (kind, dedupe_key, playlist_id, position, album_url, track_bcid, track_num, track_title, created_at)
       SELECT 'playlist_track', json_extract(j.value, '$.dedupe_key'), ?, json_extract(j.value, '$.position'), json_extract(j.value, '$.album_url'),
              json_extract(j.value, '$.track_bcid'), json_extract(j.value, '$.track_num'), json_extract(j.value, '$.track_title'), json_extract(j.value, '$.created_at')
       FROM json_each(?) AS j`,
      [id, JSON.stringify(snap.pending)],
    );
  }
  return id;
}
