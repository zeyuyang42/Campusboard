// Library export and import: one versioned JSON file that moves a library to another Mac.
//
// The file names everything by Bandcamp identity (canonical album URLs, Bandcamp track and
// band ids), never by local row ids, and carries no secrets or caches: no identity cookie,
// sync status, page cache, stream URLs or art palettes. Importing queues the albums the
// library lacks through the normal job runner and records what depends on them (playlist
// entries, plays, muted artists, dismissed releases) in import_pending, which the runner
// resolves after every album it imports. See db/repos/importPending.ts.
import { z } from "zod";
import type { Db } from "../db/Db.js";
import { chunks, now, sqlTime as toSqlTime, valuesList } from "../db/Db.js";
import { activeSql } from "../db/repos/jobs.js";
import { getSetting, setSetting } from "../db/repos/settings.js";
import { recomputeOwned } from "../db/repos/fanItems.js";
import { addPending, resolvePending, type PendingRow } from "../db/repos/importPending.js";
import { normalizePlaylistName } from "../db/repos/playlists.js";
import { addPendingNotes, exportAlbumNotes, NOTE_MAX, RATING_MAX } from "../db/repos/albumNotes.js";
import { parseRuleJson, parseSmartRule, SmartRuleSchema } from "../db/repos/smartPlaylists.js";
import { isBandcampHost, releaseUrlOrNull } from "../scrape/url.js";
import { normalizeFanUsername } from "../scrape/fan.js";
import { releasePath } from "../db/repos/releases.js";
import { ACCOUNT_KEY, setUsername } from "./account.js";
import { followSystem, parseTheme, toPortable } from "../theme/schema.js";
import { PLAYLIST_NAME_MAX, RELEASE_CHECK_SETTING_KEY } from "../config.js";
import type { JobRunner } from "./jobRunner.js";
import type { Job } from "../types.js";

export const LIBRARY_FORMAT = "bandcamp-player-library";
/** Bump only for changes an older app can't read; additive fields keep the version. */
export const LIBRARY_EXPORT_VERSION = 1;
/** settings key: this library's random id, so playlists imported from it can be recognised. */
export const LIBRARY_ID_KEY = "library_id";
export const THEME_SETTING_KEY = "theme";
export const LIBRARY_VIEW_SETTING_KEY = "library_view";

const MAX_ITEMS = 200_000;
/** Largest file accepted, in characters of text (checked before JSON.parse). */
export const MAX_LIBRARY_FILE_CHARS = 50 * 1024 * 1024;
/** Totals across the whole file, so a file within every per-array cap still can't be huge. */
export const MAX_PLAYLIST_ENTRIES = 200_000;
export const MAX_PLAYS = 500_000;
const BATCH = 500;
const str = (max: number) => z.string().max(max);
const httpsUrl = str(2048).refine((u) => /^https:\/\/[^/\s]+(\/|$)/.test(u), "not an https URL");
const id = z.number().int().safe();
const sqlTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "not a date and time");

const TrackRefSchema = z.object({
  album_url: httpsUrl,
  track_id: id.nullable(),
  track_num: z.number().int().min(0).max(100_000).nullable(),
  title: str(1000),
});

const AlbumSchema = z.object({
  url: httpsUrl,
  item_type: z.enum(["album", "track"]),
  bandcamp_id: id,
  title: str(1000),
  artist: str(1000),
  artist_url: httpsUrl.nullable(),
  band_id: id.nullable(),
  owned: z.boolean(),
  wishlisted: z.boolean(),
  /** The name.bandcamp.com address of a purchased or wishlisted release (for the next sync). */
  fetch_url: httpsUrl.nullable(),
});

const PlaylistSchema = z.object({
  /** "<library id>:<playlist id>" in the exporting library. */
  key: str(200),
  name: str(1000),
  created_at: str(40),
  tracks: z.array(TrackRefSchema).max(MAX_ITEMS),
});

/** A smart playlist (#84): its rule, never its tracks. Older builds drop the whole field. */
const SmartPlaylistSchema = z.object({
  key: str(200),
  name: str(1000),
  created_at: str(40),
  rule: SmartRuleSchema,
});

const PlaySchema = TrackRefSchema.extend({ played_at: sqlTime, seconds: z.number().min(0).max(86_400) });

/**
 * The sorts and filters a version 1 file may carry. Fixed, not ALBUM_SORTS: a newer sort
 * (Rating, #73) would make older builds refuse the whole file, so such a view isn't exported.
 */
const LibraryViewSchema = z.object({ sort: z.enum(["added", "played", "plays", "artist", "title", "release"]), filter: z.enum(["all", "purchased", "wishlist"]) });

/** An album's note and rating (#73), by album URL. Older builds drop the whole field. */
const NoteSchema = z.object({
  album_url: httpsUrl,
  rating: z.number().int().min(0).max(RATING_MAX),
  note: str(NOTE_MAX * 2), // UTF-16 units; the repo keeps NOTE_MAX characters
  updated_at: sqlTime,
});

export const LibraryExportSchema = z.object({
  format: z.literal(LIBRARY_FORMAT),
  version: z.literal(LIBRARY_EXPORT_VERSION),
  exported_at: str(40),
  library_id: str(100),
  app_version: str(40).optional(),
  albums: z.array(AlbumSchema).max(MAX_ITEMS),
  playlists: z.array(PlaylistSchema).max(10_000),
  /** null when the export left listening history out. */
  history: z.array(PlaySchema).max(1_000_000).nullable(),
  new_releases: z.object({
    checks_enabled: z.boolean(),
    muted: z.array(z.object({ band_id: id, artist_url: httpsUrl, name: str(1000) })).max(MAX_ITEMS),
    dismissed: z.array(z.object({
      band_id: id, url: httpsUrl, item_type: z.enum(["album", "track"]), title: str(1000), art_id: id.nullable(), artist_override: str(1000).nullable(),
    })).max(MAX_ITEMS),
  }),
  settings: z.object({
    /**
     * As stored under settings.key='theme'; validated with ThemeSchema on import. A system theme
     * is written as its dark or light side plus mode "system" here, so older builds (which
     * refuse mode "system" and drop the unknown key) still import the library.
     */
    theme: z.object({ theme: z.unknown(), basePreset: str(100).optional(), mode: z.literal("system").optional() }).nullable(),
    library_view: LibraryViewSchema.nullable(),
  }),
  /** Added after version 1 shipped; optional so older files still parse. */
  notes: z.array(NoteSchema).max(MAX_ITEMS).optional(),
  /** Smart playlists (#84), added after version 1 shipped; a separate field so older builds ignore them entirely. */
  smart_playlists: z.array(SmartPlaylistSchema).max(10_000).optional(),
  account: z.object({
    username: str(100).nullable().refine((u) => {
      if (u === null) return true;
      try { return normalizeFanUsername(u) === u; } catch { return false; }
    }, "not a Bandcamp username"),
  }),
});

export type LibraryExport = z.infer<typeof LibraryExportSchema>;
export type ParsedLibrary = { data: LibraryExport; error?: undefined } | { data?: undefined; error: string };

/** Validate a library file. Errors are sentences for the UI, never a dump of the input. */
export function parseLibraryExport(text: string): ParsedLibrary {
  if (text.length > MAX_LIBRARY_FILE_CHARS) return { error: "This library file is too large to import (over 50 MB)." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "This file isn't a library export: it isn't valid JSON." };
  }
  const head = (raw && typeof raw === "object" ? raw : {}) as { format?: unknown; version?: unknown };
  if (head.format !== LIBRARY_FORMAT) return { error: "This file isn't a Campusboard library export." };
  if (typeof head.version !== "number" || !Number.isInteger(head.version) || head.version < 1) {
    return { error: "This library file is damaged: its version is missing or invalid." };
  }
  if (head.version > LIBRARY_EXPORT_VERSION) {
    return { error: "This library file was made by a newer version of Campusboard. Update the app, then import it again." };
  }
  const r = LibraryExportSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { error: `This library file is damaged (${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}).` };
  }
  const entries = r.data.playlists.reduce((n, p) => n + p.tracks.length, 0);
  if (entries > MAX_PLAYLIST_ENTRIES) return { error: `This library file is too large to import: its playlists hold more than ${MAX_PLAYLIST_ENTRIES.toLocaleString("en-US")} tracks.` };
  if ((r.data.history?.length ?? 0) > MAX_PLAYS) return { error: `This library file is too large to import: it has more than ${MAX_PLAYS.toLocaleString("en-US")} plays.` };
  if (r.data.settings.theme) {
    const t = parseTheme(r.data.settings.theme.theme);
    if (!t.theme) return { error: `This library file is damaged (settings.theme: ${t.error}).` };
  }
  return { data: r.data };
}

async function libraryId(db: Db, create: boolean): Promise<string | null> {
  const have = await getSetting<string>(db, LIBRARY_ID_KEY);
  if (have || !create) return have;
  const fresh = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await setSetting(db, LIBRARY_ID_KEY, fresh);
  return (await getSetting<string>(db, LIBRARY_ID_KEY)) ?? fresh;
}

const TRACK_REF = "al.url AS album_url, t.track_id, t.track_num, t.title";

/** A smart playlist's key in a library file (#84): "<library id>:smart:<playlist id>@<created_at>". */
const smartKey = (lib: string, id: number, createdAt: string) => `${lib}:smart:${id}@${createdAt}`;
/** The playlist id in a key from this library: "<lib>:<id>", or a smartKey. */
function ownPlaylistId(key: string): number {
  const smart = /:smart:(\d+)@/.exec(key);
  return Number(smart ? smart[1] : key.slice(key.lastIndexOf(":") + 1));
}

/** Everything worth moving to another Mac, as a plain object ready for JSON.stringify. */
export async function exportLibrary(db: Db, opts: { history?: boolean; appVersion?: string } = {}): Promise<LibraryExport> {
  const lib = (await libraryId(db, true))!;
  const albums = (await db.select<Omit<LibraryExport["albums"][number], "owned" | "wishlisted"> & { owned: number; wishlisted: number }>(
    `SELECT al.url, al.item_type, al.bandcamp_id, al.title, ar.name AS artist, ar.url AS artist_url, ar.band_id, al.owned,
       EXISTS (SELECT 1 FROM fan_items f WHERE f.list = 'wishlist' AND f.item_type = al.item_type AND f.bandcamp_id = al.bandcamp_id) AS wishlisted,
       (SELECT f.fetch_url FROM fan_items f WHERE f.item_type = al.item_type AND f.bandcamp_id = al.bandcamp_id ORDER BY f.list LIMIT 1) AS fetch_url
     FROM albums al JOIN artists ar ON ar.id = al.artist_id ORDER BY al.created_at, al.id`,
  )).map((a) => ({ ...a, owned: !!a.owned, wishlisted: !!a.wishlisted }));

  const playlists: LibraryExport["playlists"] = [];
  for (const p of await db.select<{ id: number; name: string; created_at: string }>(
    "SELECT id, name, created_at FROM playlists WHERE id NOT IN (SELECT playlist_id FROM smart_playlists) ORDER BY created_at, id",
  )) {
    const tracks = await db.select<LibraryExport["playlists"][number]["tracks"][number]>(
      `SELECT ${TRACK_REF} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN albums al ON al.id = t.album_id
       WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id`,
      [p.id],
    );
    playlists.push({ key: `${lib}:${p.id}`, name: p.name, created_at: p.created_at, tracks });
  }

  const smart: NonNullable<LibraryExport["smart_playlists"]> = [];
  for (const p of await db.select<{ id: number; name: string; created_at: string; rule_json: string }>(
    "SELECT p.id, p.name, p.created_at, s.rule_json FROM playlists p JOIN smart_playlists s ON s.playlist_id = p.id ORDER BY p.created_at, p.id",
  )) {
    const rule = parseRuleJson(p.rule_json);
    // Not "<library>:<id>" like an ordinary playlist: SQLite reuses a deleted playlist's id,
    // and an earlier import may have mapped that key to an ordinary playlist.
    if (rule) smart.push({ key: smartKey(lib, p.id, p.created_at), name: p.name, created_at: p.created_at, rule });
  }

  const history = opts.history === false ? null : await db.select<NonNullable<LibraryExport["history"]>[number]>(
    `SELECT ${TRACK_REF}, p.played_at, p.seconds_listened AS seconds FROM plays p JOIN tracks t ON t.id = p.track_id JOIN albums al ON al.id = t.album_id
     ORDER BY p.played_at, p.id`,
  );

  const muted = await db.select<LibraryExport["new_releases"]["muted"][number]>(
    "SELECT ar.band_id, ar.url AS artist_url, ar.name FROM release_watch w JOIN artists ar ON ar.id = w.artist_id WHERE w.muted = 1 ORDER BY ar.id",
  );
  const dismissed = await db.select<LibraryExport["new_releases"]["dismissed"][number]>(
    `SELECT ar.band_id, r.url, r.item_type, r.title, r.art_id, r.artist_override FROM artist_releases r JOIN artists ar ON ar.id = r.artist_id
     WHERE r.status = 'dismissed' ORDER BY r.id`,
  );

  const theme = await getSetting<{ theme?: unknown; basePreset?: string }>(db, THEME_SETTING_KEY);
  const view = LibraryViewSchema.safeParse(await getSetting(db, LIBRARY_VIEW_SETTING_KEY));
  const checks = await getSetting<{ enabled?: boolean }>(db, RELEASE_CHECK_SETTING_KEY);
  // Only the username: the identity cookie and the sync summary stay on this Mac.
  const account = await getSetting<{ username?: string }>(db, ACCOUNT_KEY);
  const validTheme = theme && parseTheme(theme.theme).theme;

  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    library_id: lib,
    ...(opts.appVersion ? { app_version: opts.appVersion } : {}),
    albums,
    playlists,
    history,
    new_releases: { checks_enabled: checks?.enabled !== false, muted, dismissed },
    settings: {
      theme: validTheme ? {
        theme: toPortable(validTheme),
        ...(theme?.basePreset ? { basePreset: theme.basePreset } : {}),
        ...(validTheme.mode === "system" ? { mode: "system" as const } : {}),
      } : null,
      library_view: view.success ? view.data : null,
    },
    account: { username: account?.username ?? null },
    notes: await exportAlbumNotes(db),
    smart_playlists: smart,
  };
}

interface LibraryState {
  urls: Set<string>;
  ids: Set<string>;
  trackIds: Set<number>;
  queued: Set<string>;
  names: Map<string, number[]>;
  /** source_key -> playlist id, for playlists an earlier import created. */
  mapped: Map<string, number>;
  /** Smart playlists here (#84), with their rule as stored. */
  smart: Map<number, string>;
  /** Playlists an interrupted import claimed (name chosen) but may not have finished creating. */
  claims: Map<string, string>;
  libraryId: string | null;
  playlistIds: Map<number, string>;
  username: string | null;
}

async function libraryState(db: Db): Promise<LibraryState> {
  const albums = await db.select<{ url: string; item_type: string; bandcamp_id: number }>("SELECT url, item_type, bandcamp_id FROM albums");
  const tracks = await db.select<{ track_id: number }>("SELECT track_id FROM tracks");
  // URLs an unfinished job will fetch anyway (an earlier import of the same file, say).
  const queued = await db.select<{ url: string }>(
    `SELECT ji.url FROM job_items ji JOIN jobs j ON j.id = ji.job_id WHERE ${activeSql("j.status")} AND ji.status IN ('queued','running')`,
  );
  const playlists = await db.select<{ id: number; name: string; created_at: string }>("SELECT id, name, created_at FROM playlists");
  const names = new Map<string, number[]>();
  for (const p of playlists) names.set(p.name.toLowerCase(), [...(names.get(p.name.toLowerCase()) ?? []), p.id]);
  const mapped = await db.select<{ source_key: string; playlist_id: number }>("SELECT source_key, playlist_id FROM imported_playlists WHERE playlist_id IN (SELECT id FROM playlists)");
  const smart = await db.select<{ playlist_id: number; rule_json: string }>("SELECT playlist_id, rule_json FROM smart_playlists");
  const claims = await db.select<{ source_key: string; name: string }>("SELECT source_key, name FROM imported_playlists WHERE playlist_id IS NULL");
  return {
    urls: new Set(albums.map((a) => a.url)),
    ids: new Set(albums.map((a) => `${a.item_type}:${a.bandcamp_id}`)),
    trackIds: new Set(tracks.map((t) => t.track_id)),
    queued: new Set(queued.map((q) => q.url)),
    names,
    mapped: new Map(mapped.map((m) => [m.source_key, m.playlist_id])),
    smart: new Map(smart.map((r) => [r.playlist_id, JSON.stringify(parseRuleJson(r.rule_json))])),
    claims: new Map(claims.map((c) => [c.source_key, c.name])),
    libraryId: await libraryId(db, false),
    playlistIds: new Map(playlists.map((p) => [p.id, p.created_at])),
    username: (await getSetting<{ username?: string }>(db, ACCOUNT_KEY))?.username ?? null,
  };
}

function hasAlbum(s: LibraryState, a: LibraryExport["albums"][number]): boolean {
  return s.urls.has(a.url) || s.ids.has(`${a.item_type}:${a.bandcamp_id}`) || (a.item_type === "track" && s.trackIds.has(a.bandcamp_id));
}

/**
 * The fan_items addresses for a marked album, or null to drop the mark. Both go through
 * normalizeBandcampUrl; the fetch URL (the one the identity cookie and album refreshes use)
 * must be on a bandcamp.com host and name the same release path as the album, so a file
 * can't point a purchased album's refresh at some other page.
 */
function fanAddresses(a: LibraryExport["albums"][number]): { url: string; fetch_url: string } | null {
  const url = releaseUrlOrNull(a.url);
  if (!url) return null;
  const fetch = a.fetch_url === null ? url : releaseUrlOrNull(a.fetch_url);
  if (!fetch || !isBandcampHost(new URL(fetch).hostname) || releasePath(fetch) !== releasePath(url)) return null;
  return { url, fetch_url: fetch };
}

/** "Name", else "Name (2)", "Name (3)" ...: never a name already taken (case-insensitively). */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const name = `${Array.from(base).slice(0, PLAYLIST_NAME_MAX - suffix.length).join("").trimEnd()}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

async function trackSequence(db: Db, playlistId: number): Promise<string> {
  const rows = await db.select<{ k: string }>(
    `SELECT COALESCE(CAST(t.track_id AS TEXT), al.url || '#' || t.title) AS k FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? ORDER BY pt.position, pt.id`,
    [playlistId],
  );
  return rows.map((r) => r.k).join(",");
}

type PlaylistPlan = { key: string; name: string; status: "present" } | { key: string; name: string; status: "new"; createAs: string };
type FilePlaylist = Pick<LibraryExport["playlists"][number], "key" | "name" | "created_at"> & (
  | { tracks: LibraryExport["playlists"][number]["tracks"]; rule?: undefined }
  | { tracks?: undefined; rule: NonNullable<LibraryExport["smart_playlists"]>[number]["rule"] }
);

/** The file's playlists, then its smart playlists (#84), in the order planPlaylists plans them. */
const filePlaylists = (data: LibraryExport): FilePlaylist[] => [...data.playlists, ...(data.smart_playlists ?? [])];

/**
 * Which playlists already exist here: created by an earlier import of this library, the
 * very same playlist (importing into the library that exported it), or one with the same
 * name and the same tracks in the same order. The rest are created, renamed with a
 * " (2)" style suffix when the name is taken: an existing playlist is never overwritten.
 */
async function planPlaylists(db: Db, data: LibraryExport, s: LibraryState): Promise<PlaylistPlan[]> {
  const taken = new Set(s.names.keys());
  const plans: PlaylistPlan[] = [];
  for (const p of filePlaylists(data)) {
    const name = normalizePlaylistName(p.name) ?? "Imported playlist";
    const ownId = data.library_id === s.libraryId ? ownPlaylistId(p.key) : NaN;
    let present = s.mapped.has(p.key) || (Number.isInteger(ownId) && s.playlistIds.get(ownId) === p.created_at);
    if (!present && p.rule) {
      // A smart playlist of the same name with the same rule.
      const want = JSON.stringify(parseSmartRule(p.rule));
      present = (s.names.get(name.toLowerCase()) ?? []).some((c) => s.smart.get(c) === want);
    } else if (!present && p.tracks) {
      const want = p.tracks.map((t) => (t.track_id != null ? String(t.track_id) : `${t.album_url}#${t.title}`)).join(",");
      for (const candidate of s.names.get(name.toLowerCase()) ?? []) {
        if (!s.smart.has(candidate) && (await trackSequence(db, candidate)) === want) { present = true; break; }
      }
    }
    if (present) { plans.push({ key: p.key, name, status: "present" }); continue; }
    const createAs = s.claims.get(p.key) ?? freeName(name, taken);
    taken.add(createAs.toLowerCase());
    plans.push({ key: p.key, name, status: "new", createAs });
  }
  return plans;
}

export interface LibraryImportPreview {
  albums: { total: number; new: number; present: number; invalid: number };
  playlists: { total: number; new: number; present: number; renamed: { from: string; to: string }[] };
  /** Plays in the file (null when the export left history out). */
  plays: number | null;
  settings: { theme: boolean; libraryView: boolean };
  newReleases: { muted: number; dismissed: number };
  /**
   * The file's username, whether importing uses it (this library has none, or the same one),
   * and how many albums carry a Purchased or Wishlist mark.
   */
  account: { username: string | null; applies: boolean; marks: number };
  /** Album notes and ratings in the file (#73). */
  notes: number;
}

function accountApplies(s: LibraryState, data: LibraryExport): boolean {
  const u = data.account.username;
  return !!u && (!s.username || s.username.toLowerCase() === u.toLowerCase());
}

/** What importing `data` would do, without changing anything. */
export async function previewLibraryImport(db: Db, data: LibraryExport): Promise<LibraryImportPreview> {
  const s = await libraryState(db);
  let present = 0, invalid = 0;
  for (const a of data.albums) {
    if (hasAlbum(s, a)) present++;
    else if (!releaseUrlOrNull(a.url)) invalid++;
  }
  const plans = await planPlaylists(db, data, s);
  const created = plans.filter((p): p is Extract<PlaylistPlan, { status: "new" }> => p.status === "new");
  return {
    albums: { total: data.albums.length, new: data.albums.length - present - invalid, present, invalid },
    playlists: {
      total: plans.length, new: created.length, present: plans.length - created.length,
      renamed: created.filter((p) => p.createAs !== p.name).map((p) => ({ from: p.name, to: p.createAs })),
    },
    plays: data.history ? data.history.length : null,
    settings: { theme: !!data.settings.theme, libraryView: !!data.settings.library_view },
    newReleases: { muted: data.new_releases.muted.length, dismissed: data.new_releases.dismissed.length },
    account: { username: data.account.username, applies: accountApplies(s, data), marks: data.albums.filter((a) => a.owned || a.wishlisted).length },
    notes: data.notes?.length ?? 0,
  };
}

export interface LibraryImportOptions {
  /** Merge the file's listening history (default true). */
  history?: boolean;
  /** Use the file's theme, Library view and new-release checking choice (default true). */
  settings?: boolean;
  /** Shown as the import job's source, e.g. the file name. */
  label?: string;
}

export interface LibraryImportResult {
  /** The job importing the missing albums, or null when the library had them all. */
  job: Job | null;
  queued: number;
  playlistsCreated: number;
  /** Written right away because their albums were already here. */
  resolved: { tracks: number; plays: number };
}

/**
 * Import a validated library file. Steps run in an order where an interruption leaves a
 * readable library and a second run finishes the job without duplicating anything: the
 * account and flags first, settings, playlists (claimed, created, linked, then their pending
 * entries), pending plays and preferences, the resolve for what is already
 * here, and the job for the missing albums last.
 */
export async function importLibrary(db: Db, runner: JobRunner, data: LibraryExport, opts: LibraryImportOptions = {}): Promise<LibraryImportResult> {
  const s = await libraryState(db);

  // The username only fills an empty account; another account's Purchased and Wishlist
  // marks would be wrong here, so flags come along only for this or a new account.
  if (accountApplies(s, data)) {
    if (!s.username) await setUsername(db, data.account.username!);
    const flagged = data.albums.flatMap((a) => {
      const at = a.owned || a.wishlisted ? fanAddresses(a) : null;
      if (!at) return [];
      return [...(a.owned ? [["collection", a, at] as const] : []), ...(a.wishlisted ? [["wishlist", a, at] as const] : [])];
    });
    // sync_job 0: the next complete sync replaces these with what the account really holds.
    for (const chunk of chunks(flagged, BATCH)) {
      await db.run(
        `INSERT OR IGNORE INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, title, artist, sync_job) VALUES ${valuesList(chunk.length, 8)}`,
        chunk.flatMap(([list, a, at]) => [list, a.item_type, a.bandcamp_id, at.url, at.fetch_url, a.title, a.artist, 0]),
      );
    }
    if (flagged.length) await recomputeOwned(db);
  }

  if (opts.settings !== false) {
    const parsed = data.settings.theme && parseTheme(data.settings.theme.theme).theme;
    const t = parsed && data.settings.theme?.mode === "system" ? followSystem(parsed) : parsed;
    if (t) await setSetting(db, THEME_SETTING_KEY, { theme: t, basePreset: data.settings.theme?.basePreset ?? t.name });
    if (data.settings.library_view) await setSetting(db, LIBRARY_VIEW_SETTING_KEY, data.settings.library_view);
    await setSetting(db, RELEASE_CHECK_SETTING_KEY, { enabled: data.new_releases.checks_enabled });
  }

  let playlistsCreated = 0;
  const plans = await planPlaylists(db, data, s);
  const inFile = filePlaylists(data);
  for (const [i, plan] of plans.entries()) {
    const p = inFile[i];
    if (p.rule) {
      // The rule goes in after the playlist, with INSERT OR IGNORE: a rerun after an
      // interruption gives the playlist an earlier run created (mapped) its rule, and an
      // existing rule is never replaced. Only ever an empty playlist: one with tracks, stored
      // or pending, is an ordinary playlist and stays one.
      const pid = plan.status === "new" ? await createImportedPlaylist(db, p.key, plan.createAs) : s.mapped.get(p.key);
      if (pid !== undefined) {
        await db.run(
          `INSERT OR IGNORE INTO smart_playlists (playlist_id, rule_json) SELECT ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM playlist_tracks WHERE playlist_id = ?)
             AND NOT EXISTS (SELECT 1 FROM import_pending WHERE kind = 'playlist_track' AND playlist_id = ?)`,
          [pid, JSON.stringify(parseSmartRule(p.rule)), pid, pid],
        );
      }
      if (plan.status === "new") playlistsCreated++;
      continue;
    }
    if (plan.status !== "new") continue;
    const pid = await createImportedPlaylist(db, p.key, plan.createAs);
    await addPending(db, p.tracks.map((t, position): PendingRow => ({
      kind: "playlist_track", playlist_id: pid, position, album_url: t.album_url, track_bcid: t.track_id, track_num: t.track_num, track_title: t.title,
    })));
    playlistsCreated++;
  }

  if (opts.history !== false && data.history) {
    await addPending(db, data.history.map((h): PendingRow => ({
      kind: "play", album_url: h.album_url, track_bcid: h.track_id, track_num: h.track_num, track_title: h.title, played_at: h.played_at, seconds: h.seconds,
    })));
  }
  await addPending(db, [
    ...data.new_releases.muted.map((m): PendingRow => ({ kind: "mute", band_id: m.band_id })),
    // Stored in artist_releases later, so only addresses normalizeBandcampUrl accepts.
    ...data.new_releases.dismissed.flatMap((d): PendingRow[] => {
      const url = releaseUrlOrNull(d.url);
      return url ? [{ kind: "dismissed", band_id: d.band_id, release_url: url, item_type: d.item_type, title: d.title, art_id: d.art_id, artist_override: d.artist_override }] : [];
    }),
  ]);

  // Notes and ratings wait by album URL and merge as their albums arrive: a local edit that
  // is as new or newer is kept (#73). Only addresses an album here could have.
  if (data.notes?.length) {
    // Matched by the address as exported (al.url), like playlist entries and plays. A time
    // after the export or after now (a clock ahead, a hand-edited file) is capped, so it
    // can't win over every later local edit.
    const exported = new Date(data.exported_at);
    const cap = [now(), ...(Number.isNaN(exported.getTime()) ? [] : [toSqlTime(exported)])].sort()[0];
    await addPendingNotes(db, data.notes.filter((n) => releaseUrlOrNull(n.album_url)).map((n) => (n.updated_at > cap ? { ...n, updated_at: cap } : n)));
  }

  const resolved = await resolvePending(db);

  const missing = [...new Set(data.albums.filter((a) => !hasAlbum(s, a)).map((a) => releaseUrlOrNull(a.url)).filter((u): u is string => !!u && !s.queued.has(u)))];
  const job = missing.length ? await runner.enqueueSelection({ urls: missing, label: opts.label ?? "Library file", kind: "library" }) : null;
  return { job, queued: missing.length, playlistsCreated, resolved };
}

/**
 * Create the playlist for source playlist `key`, safe to repeat after an interruption at any
 * point: the claim row (with the chosen name) goes in first, the playlist second, the link
 * last. A rerun that finds a claim without a link adopts the unlinked playlist of that name
 * created since the claim, instead of making a second one.
 */
async function createImportedPlaylist(db: Db, key: string, name: string): Promise<number> {
  await db.run("INSERT INTO imported_playlists (source_key, name, claimed_at) VALUES (?, ?, ?) ON CONFLICT(source_key) DO NOTHING", [key, name, now()]);
  const claim = (await db.get<{ name: string; claimed_at: string; playlist_id: number | null }>(
    "SELECT name, claimed_at, playlist_id FROM imported_playlists WHERE source_key = ?", [key]))!;
  let pid = claim.playlist_id;
  if (pid === null) {
    const orphan = await db.get<{ id: number }>(
      `SELECT id FROM playlists p WHERE p.name = ? AND p.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM imported_playlists m WHERE m.playlist_id = p.id) ORDER BY id LIMIT 1`,
      [claim.name, claim.claimed_at],
    );
    pid = orphan?.id ?? (await db.get<{ id: number }>("INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id", [claim.name, now(), now()]))!.id;
    await db.run("UPDATE imported_playlists SET playlist_id = ? WHERE source_key = ?", [pid, key]);
  }
  return pid;
}

/**
 * Copy the whole database to `path` with VACUUM INTO, which works while the app is using it
 * and produces a compact, consistent snapshot. The file must not exist yet (SQLite refuses
 * to overwrite one); the app writes to a fresh file in its data folder and copies it over.
 */
export async function backupDatabase(db: Db, path: string): Promise<void> {
  if (!path || /[\0]/.test(path)) throw new Error("Invalid backup path");
  await db.run("VACUUM INTO ?", [path]);
}
