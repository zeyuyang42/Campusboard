// Dev-only end-to-end check that runs inside the Tauri window when VITE_SELFTEST=1.
// Results are written to the `settings` table (key "selftest") so a script outside
// the app can read them from the SQLite file.
import { getCore } from "./api/core";
import { listenedSeconds, usePlayer } from "./player/store";
import { activeAudio, transitionInfo } from "./player/store";
import { mediaSessionInfo, runMediaSessionAction } from "./player/mediaSession";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/api/app";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { BaseDirectory } from "@tauri-apps/api/path";
import { copyFile, exists, mkdir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { resendMenuBar } from "./lib/menuBar";
import { appConfigDir, appDataDir, join } from "@tauri-apps/api/path";
import { storeBackgroundImage } from "./lib/files";
import { backupLibraryDatabase, exportLibraryFile } from "./lib/libraryFile";
import { miniBridgeInfo } from "./player/miniBridge";
import { usePalette } from "./ui/palette";
import { DEFAULT_THEME, MINI_EVENTS, positionToGain, toggleAction, type Track } from "@bc/core";
import { FAN_ITEMS_ENDPOINT, fanPageUrl, parseFanItemsResponse, parseFanPage, repos, type FanItem } from "@bc/core";

/**
 * A page timer raced with one timed in Rust, for a page whose timers WebKit throttles (hidden
 * or covered, muted media). When WebKit stops the page outright (#67) neither resolves, which
 * is what `keep-awake` at the start of the run is for.
 */
const sleep = (ms: number) => Promise.race([
  new Promise<void>((r) => setTimeout(r, ms)),
  invoke<void>("selftest_sleep", { ms }).catch(() => new Promise<void>((r) => setTimeout(r, ms))),
]);

/**
 * Marks progress inside a block (written to settings.key='selftest_progress'). Throws once the
 * block has timed out, so a block left running in the background stops at its next step
 * instead of hiding the window or changing the player under the blocks after it.
 */
type Step = (label: string) => void;
class Abandoned extends Error {}

/**
 * The main window hidden (or minimized) from Rust, with a guard there that shows it again
 * after `guardMs` if the page never does: WebKit may stop a hidden, silent page's timers
 * altogether (#67), and then a `sleep` before `show()` never returns. A guard that fired
 * leaves the step's checks failing, not the run hanging.
 */
interface WindowReply { guardShows: number; awake: Record<string, boolean> | null }
const selftestWindow = (action: string, ms?: number) => invoke<WindowReply>("selftest_window", { action, ms });
const mainWindow = {
  hide: (s: Step, guardMs: number) => { s("hide main window"); return selftestWindow("hide", guardMs); },
  /** Arm the guard only, before something else hides or minimizes the window. */
  arm: (guardMs: number) => selftestWindow("arm", guardMs),
  /** Disarm the guard, show and focus. Resolves to how many times a guard has fired. */
  show: () => selftestWindow("show").then((r) => r.guardShows),
  /** Ask WebKit not to throttle or suspend the page while hidden or covered; says what applied. */
  keepAwake: () => selftestWindow("keep-awake").then((r) => r.awake),
};

/** console.error/warn and uncaught errors of the main webview during the run. */
const consoleLog: string[] = [];
function captureConsole() {
  const push = (line: string) => { if (consoleLog.length < 60) consoleLog.push(line.slice(0, 600)); };
  const fmt = (a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => { push(`${level}: ${args.map(fmt).join(" ")}`); orig(...args); };
  }
  window.addEventListener("error", (e) => push(`uncaught: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => push(`unhandled rejection: ${fmt(e.reason)}`));
}
const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ARTIST = "https://music.zoekeating.com";
const CUSTOM_ALBUM = `${CUSTOM_ARTIST}/album/snowmelt-ep`;
/**
 * A public fan profile for the collection check, from VITE_SELFTEST_FAN (skipped when unset,
 * so no third party's username lives in the repo). The check never touches the account in
 * Settings: it reads the fan page and one small API page through the app's own queue and
 * http plugin, imports one purchase and deletes it again unless it was already in the library.
 */
const SELFTEST_FAN = import.meta.env.VITE_SELFTEST_FAN as string | undefined;

/**
 * The Library filter's escaped LIKE and the release-date sort through the real SQL plugin,
 * against the album the selftest just imported. Read-only.
 */
async function libraryFilterCheck(core: Awaited<ReturnType<typeof getCore>>, album: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["album"]>>) {
  if (!album) return { ok: false, error: "no album" };
  const title = album.tracks.map((t) => t.title).filter((t) => t.includes(" ")).sort((a, b) => b.length - a.length)[0] ?? album.tracks[0].title;
  const ids = async (q: string, filter: repos.AlbumFilter = "all") => (await core.albums("added", filter, q)).map((a) => a.id);
  const byTrack = (await ids(title.toUpperCase())).includes(album.id);
  // `_` and `%` in place of a letter and a space: as wildcards they would match the title.
  const wild = `_${title.slice(1).replace(" ", "%")}`;
  const rawMatch = !!(await core.db.get("SELECT 1 FROM tracks WHERE album_id = ? AND title LIKE ?", [album.id, wild]));
  const escapedMatch = (await ids(wild)).includes(album.id);
  const combined = (await ids(title, "wishlist")).includes(album.id) === album.wishlisted;
  const sortedDesc = (list: { release_date: string | null }[]) => {
    const keys = list.map((a) => (a.release_date ? Date.parse(a.release_date) : null));
    return keys.every((k, i) => i === 0 || (k === null ? true : keys[i - 1] !== null && keys[i - 1]! >= k));
  };
  const bySort = await core.albums("release");
  const artist = await core.artist(album.artist_id);
  const ok = byTrack && rawMatch && !escapedMatch && combined && sortedDesc(bySort) && !!artist && sortedDesc(artist.albums);
  return { ok, track: title, byTrack, wild, rawMatch, escapedMatch, combined, releaseSorted: sortedDesc(bySort), releases: bySort.length, artistSorted: artist ? sortedDesc(artist.albums) : null };
}

/**
 * Browse by tag (#71) through the real SQL plugin: json_each over albums.tags_json for the tag
 * counts and the tag filter, against the album the selftest just imported. Read-only.
 */
async function tagsCheck(core: Awaited<ReturnType<typeof getCore>>, album: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["album"]>>) {
  if (!album) return { ok: false, error: "no album" };
  const t0 = performance.now();
  const tags = await core.tags();
  const countsMs = Math.round(performance.now() - t0);
  const listed = album.tags.every((t) => tags.some((x) => x.tag.toLowerCase() === t.toLowerCase() && x.album_count >= 1));
  const first = album.tags[0] ?? "";
  const filtered = first ? (await core.albums("title", "all", "", first.toUpperCase())).some((a) => a.id === album.id) : false;
  const tracks = first ? (await core.albumTracks("title", "all", "", first)).filter((t) => t.album_id === album.id).length : 0;
  const ok = album.tags.length > 0 && listed && filtered && tracks === album.tracks.length;
  return { ok, albumTags: album.tags, libraryTags: tags.length, listed, filtered, tracks, countsMs };
}

/**
 * Album notes and ratings (#73) through the real SQL plugin and migration 0009: write a rating
 * and a note on the selftest album, read them back (also through the Rating sort and the Rated
 * filter), then put back what was there before.
 */
async function albumNotesCheck(core: Awaited<ReturnType<typeof getCore>>, albumId: number | undefined) {
  if (!albumId) return { ok: false, error: "no album" };
  const before = await core.albumNote(albumId);
  const note = "selftest note: “quotes”, emoji 🎧";
  try {
    await core.setAlbumRating(albumId, 4);
    await core.setAlbumNote(albumId, note);
    const read = await core.albumNote(albumId);
    const rated = (await core.albums("rating", "rated")).find((a) => a.id === albumId);
    const migrated = !!(await core.db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'album_notes_pending'"));
    const ok = read?.rating === 4 && read.note === note && rated?.rating === 4 && migrated;
    return { ok, rating: read?.rating ?? null, noteOk: read?.note === note, inRatedSort: rated?.rating ?? null, migrated };
  } finally {
    if (before) {
      await core.db.run("UPDATE album_notes SET rating = ?, note = ?, updated_at = ? WHERE album_id = ?", [before.rating, before.note, before.updated_at, albumId]);
    } else {
      await core.db.run("DELETE FROM album_notes WHERE album_id = ?", [albumId]);
    }
  }
}

/**
 * The collection sync's job-guarded statements (INSERT ... SELECT FROM (VALUES) WHERE EXISTS
 * ... ON CONFLICT, a guarded DELETE, a guarded settings upsert) through the real SQL plugin:
 * each must write while its job runs and do nothing once it is cancelled. No network. The
 * job is inserted as 'running' so the live JobRunner never picks it up, the rows use negative
 * Bandcamp ids no real release has, and everything is removed by id afterwards.
 */
async function checkSyncGuards(core: Awaited<ReturnType<typeof getCore>>) {
  const db = core.db;
  const KEY = "selftest_sync_guard";
  const ids = [-9001, -9002];
  const item = (id: number): FanItem => ({ item_type: "album", bandcamp_id: id, url: `https://selftest.bandcamp.com/album/x${-id}`, fetch_url: `https://selftest.bandcamp.com/album/x${-id}`, title: "selftest", artist: null, token: null });
  const rows = async () => (await db.select<{ bandcamp_id: number; sync_job: number }>(
    `SELECT bandcamp_id, sync_job FROM fan_items WHERE list = 'wishlist' AND bandcamp_id IN (${ids.join(",")}) ORDER BY bandcamp_id DESC`));
  const job = await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, status) VALUES ('collection', 'selftest://sync-guard', 'running') RETURNING id");
  const jobId = job!.id;
  try {
    // While running: both rows written, the summary-style setting saved.
    await repos.upsertFanItems(db, "wishlist", [item(ids[0]), item(ids[1])], jobId);
    const written = await rows();
    const savedRunning = await repos.setSettingWhileJobRuns(db, KEY, { n: 1 }, jobId);
    // The guarded DELETE removes rows of the list not seen by this job. Only exercised
    // while running if the real wishlist is empty, so no real membership is touched.
    const realWishlist = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM fan_items WHERE list = 'wishlist' AND bandcamp_id NOT IN (${ids.join(",")})`))!.n;
    let deleteWhileRunning: unknown = "skipped (real wishlist rows present)";
    if (realWishlist === 0) {
      await db.run("UPDATE fan_items SET sync_job = ? WHERE list = 'wishlist' AND bandcamp_id = ?", [jobId + 1_000_000, ids[1]]);
      await repos.removeUnseen(db, "wishlist", jobId);
      deleteWhileRunning = (await rows()).map((r) => r.bandcamp_id);
      await repos.upsertFanItems(db, "wishlist", [item(ids[1])], jobId);
    }

    // Cancelled: every statement is a no-op.
    await db.run("UPDATE jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
    await repos.upsertFanItems(db, "wishlist", [{ ...item(ids[0]), title: "changed" }], jobId);
    const titleAfterCancel = (await db.get<{ title: string }>("SELECT title FROM fan_items WHERE list = 'wishlist' AND bandcamp_id = ?", [ids[0]]))?.title;
    await db.run("UPDATE fan_items SET sync_job = ? WHERE list = 'wishlist' AND bandcamp_id = ?", [jobId + 1_000_000, ids[1]]);
    await repos.removeUnseen(db, "wishlist", jobId);
    const afterCancelDelete = (await rows()).length;
    const savedCancelled = await repos.setSettingWhileJobRuns(db, KEY, { n: 2 }, jobId);
    const setting = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [KEY]);
    const result = {
      upsertWhileRunning: written.length === 2 && written.every((r) => r.sync_job === jobId),
      settingWhileRunning: savedRunning,
      deleteWhileRunning,
      upsertAfterCancelIgnored: titleAfterCancel === "selftest",
      deleteAfterCancelIgnored: afterCancelDelete === 2,
      settingAfterCancelIgnored: !savedCancelled && setting?.value === JSON.stringify({ n: 1 }),
    };
    const deleteOk = realWishlist !== 0 || JSON.stringify(deleteWhileRunning) === JSON.stringify([ids[0]]);
    return { ok: deleteOk && result.upsertWhileRunning && result.settingWhileRunning && result.upsertAfterCancelIgnored && result.deleteAfterCancelIgnored && result.settingAfterCancelIgnored, ...result };
  } finally {
    await db.run(`DELETE FROM fan_items WHERE bandcamp_id IN (${ids.join(",")})`);
    await db.run("DELETE FROM settings WHERE key = ?", [KEY]);
    await db.run("DELETE FROM jobs WHERE id = ?", [jobId]);
  }
}

/**
 * Listening history through the real SQL plugin: one play of the selftest's own track is
 * recorded through core (the same single INSERT the player store makes), read back through
 * the Recently played and Most played queries and the track row's count, then deleted by id.
 */
async function historyCheck(core: Awaited<ReturnType<typeof getCore>>, album: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["album"]>>) {
  if (!album?.tracks.length) return { ok: false, error: "no album" };
  const track = album.tracks[0];
  const before = (await core.album(album.id))?.tracks[0].play_count ?? 0;
  const id = await core.recordPlay(track.id, 123.4);
  if (id == null) return { ok: false, error: "recordPlay returned null" };
  try {
    const row = await core.db.get<{ track_id: number; seconds_listened: number }>("SELECT track_id, seconds_listened FROM plays WHERE id = ?", [id]);
    const recent = await core.recentlyPlayed(5);
    const most = await core.mostPlayed(1000);
    const after = (await core.album(album.id))?.tracks[0].play_count ?? 0;
    const sortedFirst = (await core.albums("played"))[0]?.id;
    const total = await core.playCount();
    const result = {
      stored: row?.track_id === track.id && Math.abs((row?.seconds_listened ?? 0) - 123.4) < 0.01,
      recentFirst: recent[0]?.id === album.id,
      inMostPlayed: most.some((a) => a.id === album.id && (a.play_count ?? 0) >= 1),
      trackCount: after === before + 1,
      sortPlayedFirst: sortedFirst === album.id,
      total,
    };
    return { ok: result.stored && result.recentFirst && result.inMostPlayed && result.trackCount && result.sortPlayedFirst && total >= 1, ...result };
  } finally {
    await core.db.run("DELETE FROM plays WHERE id = ?", [id]);
  }
}

/**
 * New releases through the real SQL plugin and http plugin: one check of the selftest's own
 * artist (its /music page, at most one request; usually a page-cache hit right after the
 * browse check) as that artist's first check, which must store everything as seen and find
 * nothing new. If the real library already watches the artist, its watch row is set aside
 * for the check and put back afterwards; the release rows the check inserted are deleted by id.
 */
/**
 * Pre-orders (#37) through the real SQL and http plugins: the imported album is dressed up
 * as a pre-order released long ago and fetched before that, so nextDuePreorder must pick it;
 * the refresh the checker would make (one request) must then clear the flag from the live
 * page and settle it. The album's real values come back with that refresh; if it fails they
 * are put back by hand.
 */
async function preorderCheck(core: Awaited<ReturnType<typeof getCore>>, album: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["album"]>>) {
  if (!album) return { ok: false, error: "no album" };
  const db = core.db;
  const orig = await db.get<{ is_preorder: number; release_date: string | null; fetched_at: string }>("SELECT is_preorder, release_date, fetched_at FROM albums WHERE id = ?", [album.id]);
  if (!orig || orig.is_preorder) return { ok: true, status: "skipped (album is a real pre-order)" };
  try {
    await db.run("UPDATE albums SET is_preorder = 1, release_date = '01 Jan 2020 00:00:00 GMT', fetched_at = '2019-12-31 00:00:00' WHERE id = ?", [album.id]);
    const due = await repos.nextDuePreorder(db, Date.now());
    const notYet = await repos.nextDuePreorder(db, Date.UTC(2020, 0, 1, 6));
    const refreshed = await core.refreshAlbum(album.id);
    const after = await repos.nextDuePreorder(db, Date.now());
    const ok = due?.id === album.id && notYet === null && refreshed?.is_preorder === false && refreshed.release_date === orig.release_date && after === null;
    return { ok, picked: due?.id === album.id, waitsForGrace: notYet === null, clearedByRefresh: refreshed?.is_preorder === false, releaseDateRestored: refreshed?.release_date === orig.release_date, settled: after === null };
  } finally {
    const now = await db.get<{ is_preorder: number }>("SELECT is_preorder FROM albums WHERE id = ?", [album.id]);
    if (now?.is_preorder) await db.run("UPDATE albums SET is_preorder = ?, release_date = ?, fetched_at = ? WHERE id = ?", [orig.is_preorder, orig.release_date, orig.fetched_at, album.id]);
  }
}

async function newReleasesCheck(core: Awaited<ReturnType<typeof getCore>>, album: Awaited<ReturnType<Awaited<ReturnType<typeof getCore>>["album"]>>) {
  if (!album) return { ok: false, error: "no album" };
  const db = core.db;
  const artistId = album.artist_id;
  const artist = await core.artist(artistId);
  if (!artist) return { ok: false, error: "no artist" };
  const musicUrl = `${new URL(artist.url).origin}/music`;
  const before = await db.get<repos.WatchRow>("SELECT * FROM release_watch WHERE artist_id = ?", [artistId]);
  const cachedAt = async () => (await db.get<{ fetched_at: number }>("SELECT fetched_at FROM page_cache WHERE url = ?", [musicUrl]))?.fetched_at ?? null;
  const cacheBefore = await cachedAt();
  const countBefore = await core.newReleaseCount();
  let created: number[] = [];
  try {
    if (before) await db.run("DELETE FROM release_watch WHERE artist_id = ?", [artistId]);
    const r = await core.checkArtistReleases(artistId);
    created = r.inserted_ids;
    const rows = created.length
      ? await db.select<{ status: string }>(`SELECT status FROM artist_releases WHERE id IN (${created.map(() => "?").join(",")})`, created)
      : [];
    const watch = await db.get<repos.WatchRow>("SELECT * FROM release_watch WHERE artist_id = ?", [artistId]);
    const requests = (await cachedAt()) === cacheBefore ? 0 : 1;
    const result = {
      status: r.status, error: r.error ?? null, releases: r.releases, inserted: created.length, found: r.found,
      allSeen: rows.every((x) => x.status === "seen"), baselined: watch?.baselined === 1, requests,
      countUnchanged: (await core.newReleaseCount()) === countBefore, hadWatchRow: !!before,
    };
    return { ok: result.status === "baseline" && result.releases > 0 && result.found === 0 && result.allSeen && result.baselined && requests <= 1 && result.countUnchanged, ...result };
  } finally {
    for (let i = 0; i < created.length; i += 100) {
      const chunk = created.slice(i, i + 100);
      await db.run(`DELETE FROM artist_releases WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
    }
    await db.run("DELETE FROM release_watch WHERE artist_id = ?", [artistId]);
    if (before) {
      await db.run("INSERT INTO release_watch (artist_id, muted, baselined, last_checked_at, last_error) VALUES (?, ?, ?, ?, ?)",
        [before.artist_id, before.muted, before.baselined, before.last_checked_at, before.last_error]);
    }
  }
}

/**
 * Library export and database backup through the real fs and SQL plugins, without dialogs:
 * the dev-only name argument writes the export to the temp folder, with that one file added
 * to the fs scope as the save dialog would (`selftest_file`). It is read back, validated and
 * previewed against this same library (which must find nothing new), then deleted. The
 * backup (VACUUM INTO through the SQL plugin, then the Rust backup command) goes to the temp
 * folder and must be an SQLite file; it is read and deleted by a debug-only command. The
 * Rust destination check must refuse the data folder, also spelled in another case.
 * Changes nothing in the library.
 */
async function libraryFileCheck(core: Awaited<ReturnType<typeof getCore>>) {
  const stamp = Date.now();
  const name = `selftest-library-${stamp}.json`;
  const backup = `selftest-backup-${stamp}.db`;
  try {
    await exportLibraryFile({ history: true }, name);
    const file = await invoke<string>("selftest_file", { action: "allow", name });
    const text = await readTextFile(file);
    const parsed = core.parseLibraryFile(text);
    const cookie = await core.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'bandcamp_identity'");
    const cookieAbsent = !text.includes("bandcamp_identity") && (!cookie || !text.includes(JSON.parse(cookie.value) as string));
    const [albums, playlists, plays] = await Promise.all([core.albums(), core.playlists(), core.playCount()]);
    const preview = parsed.data ? await core.previewLibraryImport(parsed.data) : null;
    const counts = parsed.data ? { albums: parsed.data.albums.length, playlists: parsed.data.playlists.length, plays: parsed.data.history?.length ?? null } : null;
    await remove(file);
    const removed = !(await exists(file));
    const path = await backupLibraryDatabase(backup);
    const head = path ? await invoke<string>("selftest_take_backup", { path }) : null;
    // The guard: a snapshot name that doesn't exist, so nothing is copied even if it failed open.
    const dataDir = await appDataDir();
    const refused: Record<string, string> = {};
    for (const [label, dir] of [["dataDir", dataDir], ["caseVariant", dataDir.replace("Application Support", "application support")]] as const) {
      refused[label] = await invoke("backup_library", { tmpName: "backup-1.tmp.db", defaultName: "x.db", debugDest: await join(dir, `selftest-guard-${stamp}.db`) })
        .then((r) => `allowed: ${String(r)}`, (e) => String(e));
    }
    const guardOk = Object.values(refused).every((r) => r.includes("outside the app's data folder"));
    const ok = !!parsed.data && cookieAbsent && removed && counts?.albums === albums.length && counts.playlists === playlists.length && counts.plays === plays
      && preview?.albums.new === 0 && preview.playlists.new === 0 && head === "SQLite format 3" && guardOk;
    return { ok, error: parsed.error ?? null, bytes: text.length, counts, cookieAbsent, removed, preview: preview && { albums: preview.albums, playlists: preview.playlists.new }, backup: { written: !!path, head, refused } };
  } finally {
    await invoke("selftest_file", { action: "drop", name }).catch(() => undefined);
  }
}

/** A 1x1 PNG for the theme background check. */
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

/**
 * The webview's fs scope (#78). A theme background goes the way the Settings page sends it
 * (a file the open dialog allowed, here one `selftest_file` allowed in the temp folder, copied
 * into $APPDATA/backgrounds, then painted from there), and the stored copy is deleted from
 * Rust afterwards. Then every write-like command aimed at a probe file next to the live
 * database (`<db stem>.probe`, also spelled relative to $APPDATA, and as the target of a
 * rename out of the offline folder or a copy out of backgrounds) must be refused with the
 * scope error before it touches anything, and so must a read-only `exists` of the database
 * itself. The probe names never exist; nothing in the library changes.
 */
async function fsScopeCheck() {
  const out: Record<string, unknown> = {};
  const stamp = Date.now();
  const bg = `selftest-bg-${stamp}.png`;
  const { useTheme } = await import("./theme/store");
  const saved = useTheme.getState();
  try {
    const src = await invoke<string>("selftest_file", { action: "allow", name: bg });
    await writeFile(src, PNG_1PX);
    const stored = await storeBackgroundImage(src);
    const bytes = await readFile(`backgrounds/${stored}`, { baseDir: BaseDirectory.AppData });
    useTheme.getState().load({ ...saved.theme, background: { source: "file", value: stored, blur: 0, dim: 0 } }, saved.basePreset);
    let painted = "";
    for (let i = 0; i < 30 && !painted.startsWith('url("blob:'); i++) {
      await sleep(100);
      painted = document.documentElement.style.getPropertyValue("--bg-image");
    }
    out.background = { stored: /^\d+-selftest-bg-\d+\.png$/.test(stored), bytes: bytes.length === PNG_1PX.length, painted: painted.startsWith('url("blob:') };
  } catch (e) {
    out.background = { error: String(e) };
  } finally {
    useTheme.getState().load(saved.theme, saved.basePreset);
    await invoke("selftest_file", { action: "drop", name: bg }).catch(() => undefined);
  }

  const url = await invoke<string>("library_db_url");
  const dbFile = url.replace(/^sqlite:/, "");
  const db = dbFile.startsWith("/") ? dbFile : await join(await appConfigDir(), dbFile);
  const stem = (db.split("/").pop() ?? "library.db").replace(/\.db$/, "");
  const probe = await join(db.replace(/\/[^/]+$/, ""), `${stem}.probe`);
  const AppData = { baseDir: BaseDirectory.AppData };
  const offline = await invoke<string>("offline_dir").catch(() => null);
  const attempts: Record<string, () => Promise<unknown>> = {
    writeText: () => writeTextFile(probe, "probe"),
    writeBytes: () => writeFile(probe, PNG_1PX),
    writeTextAppData: () => writeTextFile(`${stem}.probe`, "probe", AppData),
    rename: () => rename(probe, `${probe}2`),
    renameOutOfOffline: () => (offline ? rename(`${offline}/0.mp3.part`, probe) : Promise.reject(new Error("no offline folder"))),
    remove: () => remove(probe),
    removeAppData: () => remove(`${stem}.probe`, AppData),
    copyOutOfBackgrounds: () => copyFile(`backgrounds/selftest-none-${stamp}.png`, probe, { fromPathBaseDir: BaseDirectory.AppData }),
    mkdir: () => mkdir(probe),
    existsDb: () => exists(db),
  };
  const refused: Record<string, string> = {};
  for (const [label, attempt] of Object.entries(attempts)) {
    refused[label] = await attempt().then((r) => `allowed: ${String(r)}`, (e) => String(e));
  }
  // A refusal that failed open (it wrote the probe): take it away again, if the scope lets us.
  if (Object.values(refused).some((r) => r.startsWith("allowed"))) await remove(probe).catch(() => undefined);
  const scoped = Object.values(refused).every((r) => r.includes("forbidden path"));
  out.probe = probe.split("/").slice(-2).join("/");
  out.refused = Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.includes("forbidden path") ? "forbidden path" : v]));
  const b = out.background as { stored?: boolean; bytes?: boolean; painted?: boolean };
  out.ok = !!(b.stored && b.bytes && b.painted) && scoped;
  return out;
}

/**
 * Window permissions the menu bar and close-to-hide rely on. Each step runs on its own, so a
 * throw is recorded with diagnostics (which window methods exist, what was thrown) instead
 * of aborting the run, and the window is always shown again at the end.
 */
async function windowCheck(s: Step) {
  const win = getCurrentWindow();
  const errors: Record<string, unknown> = {};
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors[name] = {
        error: String(e), type: typeof e, ctor: (e as object | null)?.constructor?.name ?? null,
        winType: typeof win, label: (win as { label?: unknown })?.label ?? null,
        methods: Object.fromEntries(["isVisible", "isMaximized", "isMinimized", "isFocused", "hide", "show"].map((m) => [m, typeof (win as unknown as Record<string, unknown>)[m]])),
      };
      return null;
    }
  };
  await step("toggleMaximize", () => win.toggleMaximize()); await sleep(400);
  const maximized = await step("isMaximized", () => win.isMaximized());
  await step("toggleMaximizeBack", () => win.toggleMaximize()); await sleep(400);
  // The window's own permissions are what this checks, so the page minimizes, hides and shows
  // it; the Rust guard only brings it back if the page's timers stop meanwhile.
  s("minimize");
  await mainWindow.arm(10000);
  await step("minimize", () => win.minimize()); await sleep(400);
  const minimized = await step("isMinimized", () => win.isMinimized());
  await step("unminimize", () => win.unminimize()); await sleep(400);
  s("hide");
  await mainWindow.arm(10000);
  await step("hide", () => win.hide()); await sleep(300);
  const visibleWhileHidden = await step("isVisibleHidden", () => win.isVisible());
  await step("show", () => win.show());
  await mainWindow.show();
  await step("setFocus", () => win.setFocus()); await sleep(300);
  const visibleAgain = await step("isVisibleAgain", () => win.isVisible());
  const focused = await step("isFocused", () => win.isFocused());
  const result = { maximized, minimized, hidden: visibleWhileHidden === false, visibleAgain, focused, errors };
  // `focused` is informational: a background terminal can keep focus from the window.
  return { ok: Object.keys(errors).length === 0 && maximized === true && minimized === true && result.hidden && visibleAgain === true, ...result };
}

/**
 * Follow the system appearance (#43): setTheme needs core:window:allow-set-theme, and a
 * window appearance change must reach prefers-color-scheme, the store's listener and :root
 * without a reload. Shows a system theme without saving it, then puts the saved one back.
 */
async function appearanceCheck(s: Step) {
  const win = getCurrentWindow();
  const { useTheme } = await import("./theme/store");
  const saved = useTheme.getState();
  const read = () => ({
    query: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    resolved: useTheme.getState().resolved.mode,
    scheme: document.documentElement.style.getPropertyValue("--color-scheme"),
  });
  const out: Record<string, unknown> = {};
  try {
    useTheme.getState().load({ ...DEFAULT_THEME, mode: "system" }, DEFAULT_THEME.name);
    s("light"); await win.setTheme("light"); await sleep(600);
    out.light = read();
    s("dark"); await win.setTheme("dark"); await sleep(600);
    out.dark = read();
    s("system"); await win.setTheme(null); await sleep(600);
    out.system = { ...read(), native: await win.theme() };
  } catch (e) {
    out.error = String(e);
  } finally {
    useTheme.getState().load(saved.theme, saved.basePreset);
    await win.setTheme(saved.theme.mode === "system" ? null : saved.theme.mode).catch(() => undefined);
  }
  const same = (v: unknown, m: string) => JSON.stringify(v) === JSON.stringify({ query: m, resolved: m, scheme: m });
  out.ok = !out.error && same(out.light, "light") && same(out.dark, "dark");
  return out;
}

/**
 * Background listening: hide the window (what closing it does) for 20 s while a track plays,
 * and measure how often timeupdate still arrives and whether listening history keeps
 * accumulating. Observes the audio element without changing it.
 *
 * status "stalled" (the playhead didn't move: not playing, or buffering) says nothing about
 * the counter, so it doesn't fail the run; "failed" means the playhead moved but listened
 * time didn't keep up. Skipped in a muted run (the default, audio.ts): WebKit doesn't
 * advance muted media in a hidden window, so it would measure nothing. Use
 * VITE_SELFTEST_AUDIBLE=1 for this measurement.
 */
async function hiddenPlaybackCheck(s: Step) {
  if (activeAudio().muted) return { ok: true, status: "skipped (muted)", reason: "set VITE_SELFTEST_AUDIBLE=1 to measure" };
  if (activeAudio().paused) return { ok: true, status: "stalled", reason: "not playing" };
  let last = performance.now();
  let maxGapMs = 0;
  let reports = 0;
  const onTick = () => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    reports++;
  };
  const tickEl = activeAudio();
  tickEl.addEventListener("timeupdate", onTick);
  try {
    await mainWindow.hide(s, 40000);
    const visibility = document.visibilityState;
    last = performance.now();
    const t0 = activeAudio().currentTime, l0 = listenedSeconds(), w0 = last;
    s("hidden for 20 s");
    await sleep(20000);
    const wallSec = (performance.now() - w0) / 1000;
    const mediaSec = activeAudio().currentTime - t0;
    const listenedSec = listenedSeconds() - l0;
    const r = (x: number) => Math.round(x * 100) / 100;
    const status = mediaSec < 1 ? "stalled" : listenedSec >= mediaSec * 0.9 ? "ok" : "failed";
    return {
      ok: status !== "failed", status,
      visibility, wallSec: r(wallSec), mediaSec: r(mediaSec), listenedSec: r(listenedSec), reports, maxGapMs: Math.round(maxGapMs),
    };
  } finally {
    tickEl.removeEventListener("timeupdate", onTick);
    await mainWindow.show();
  }
}

/**
 * Now Playing / media keys: the handlers are registered with WebKit and the session carries
 * the current track. Then the registered handlers run as a remote command would, with the
 * window hidden (what closing it does), and must drive the store. The audio is muted in
 * selftest builds (audio.ts), so WebKit never publishes it as Now Playing and the user's
 * media keys stay with whatever else is playing; the system side is a manual check.
 */
async function mediaSessionCheck(s: Step) {
  const want = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"];
  const info = mediaSessionInfo();
  const cur = usePlayer.getState().current();
  const registered = want.every((a) => info.actions.includes(a as never));
  const metadata = !!cur && info.title === cur.title && info.album === cur.album_title && info.artwork.length > 0;
  const base = { muted: activeAudio().muted, registered, metadata, actions: info.actions, title: info.title, artwork0: info.artwork[0] ?? null, positionReports: info.positionReports, lastPosition: info.lastPosition };
  // Not playing (the stream didn't start): the registration and metadata were checked, the
  // handlers were not.
  if (activeAudio().paused) return { ok: registered && metadata, status: "handlers skipped (not playing)", handlers: "skipped", ...base, playbackState: info.playbackState };
  const playingState = info.playbackState === "playing";
  await mainWindow.hide(s, 15000);
  let guardShows: number | null = null;
  try {
    s("pause"); runMediaSessionAction("pause"); await sleep(600);
    const paused = activeAudio().paused && usePlayer.getState().status === "paused" && mediaSessionInfo().playbackState === "paused";
    s("play"); runMediaSessionAction("play"); await sleep(1500);
    const resumed = !activeAudio().paused && mediaSessionInfo().playbackState === "playing";
    const target = Math.min(20, Math.max(1, (usePlayer.getState().duration || 30) - 5));
    s("seekto"); runMediaSessionAction("seekto", { seekTime: target }); await sleep(800);
    const seeked = Math.abs(activeAudio().currentTime - target) < 3;
    const reportedSeek = (mediaSessionInfo().lastPosition?.position ?? -1) >= target - 1;
    s("seekbackward"); runMediaSessionAction("seekbackward"); await sleep(500);
    const steppedBack = activeAudio().currentTime < target - 5;
    const hidden = document.visibilityState;
    guardShows = await mainWindow.show();
    const ok = registered && metadata && playingState && paused && resumed && seeked && reportedSeek && steppedBack && info.positionReports > 0;
    return { ok, status: "checked", ...base, playingState, paused, resumed, seeked, reportedSeek, steppedBack, hidden, guardShows };
  } finally {
    if (guardShows == null) await mainWindow.show();
  }
}

/**
 * Mini player (web/src/mini/): open the window, check it received and rendered the state,
 * then, with the main window hidden (what closing it does), have it press its own buttons
 * and seek, and check the store followed. The mini window also reports whether its window
 * permissions work and that the database and app commands are refused to it. Muted like the
 * rest of the run; the mini window is hidden again at the end.
 */
/**
 * Gapless and crossfade (#35), muted: a queue of four tracks of the album where the last one
 * poses as another album's, so the handovers are gapless, gapless, then a 3 s crossfade. Each
 * time the playhead goes into the preload window, then (once the standby is ready) a few
 * seconds before the point, and the check waits for the standby element to take over. It
 * records whether the queue index, Now Playing's metadata and the play counter moved to the
 * new track, whether the previous element was released, the fade's volumes, and how long the
 * new element's clock took to start after play() (WKWebView's start latency, which is what is
 * left of the gap). The saved settings are put back afterwards.
 */
async function transitionCheck(tracks: Track[], s: Step) {
  if (tracks.length < 4) return { ok: false, error: `needs 4 streamable tracks, has ${tracks.length}` };
  const p0 = usePlayer.getState();
  const saved = { gapless: p0.gapless, crossfadeSec: p0.crossfadeSec };
  const r = (x: number) => Math.round(x);
  const handovers: Record<string, unknown>[] = [];
  try {
    usePlayer.getState().setPlayback({ gapless: true, crossfadeSec: 3 });
    usePlayer.getState().playTracks([tracks[0], tracks[1], tracks[2], { ...tracks[3], album_id: -1 }], 0);
    for (let i = 0; i < 100 && (activeAudio().paused || !(activeAudio().duration > 0)); i++) await sleep(100);
    if (activeAudio().paused) return { ok: false, error: "the first track didn't start" };
    for (const [i, expect] of (["gapless", "gapless", "crossfade"] as const).entries()) {
      s(`handover ${i + 1} (${expect})`);
      const n = transitionInfo().transitions.length;
      const from = activeAudio();
      const before = usePlayer.getState().index;
      // Into the preload window first (as playback reaches it 30 s before the point), and once
      // the standby is ready, a few seconds before the point (for the fade, before its 3 s).
      usePlayer.getState().seek(from.duration - 32);
      let t = 0;
      for (; t < 75 && transitionInfo().phase !== "ready"; t++) await sleep(200);
      const readyAfterMs = t * 200;
      s(`handover ${i + 1} (${expect}): seek to the point`);
      usePlayer.getState().seek(from.duration - (expect === "crossfade" ? 6 : 3));
      for (t = 0; t < 400 && transitionInfo().transitions.length === n; t++) await sleep(20);
      const rec = transitionInfo().transitions.at(-1);
      if (!rec || transitionInfo().transitions.length === n) { handovers.push({ expect, happened: false, readyAfterMs, phase: transitionInfo().phase }); break; }
      const to = activeAudio();
      const cur = usePlayer.getState().current();
      const titleNow = mediaSessionInfo().title;
      // Mid-fade: both elements play, the outgoing one's gain falls while the incoming one's rises.
      let fade: Record<string, unknown> | null = null;
      if (expect === "crossfade") {
        await sleep(1000);
        const v1 = { out: from.volume, in: to.volume, bothPlaying: !from.paused && !to.paused };
        await sleep(1000);
        const v2 = { out: from.volume, in: to.volume };
        fade = { ...v1, out2: v2.out, in2: v2.in, ramps: v2.out < v1.out && v2.in > v1.in, status: usePlayer.getState().status };
      }
      // When the new element's clock started, relative to the handover (play() was called then).
      for (let k = 0; k < 100 && to.currentTime < 0.5; k++) await sleep(20);
      const clockStart = performance.now() - to.currentTime * 1000;
      await sleep(expect === "crossfade" ? 2500 : 1500);
      handovers.push({
        expect, kind: rec.kind, happened: true, readyAfterMs, fadeSec: rec.fadeSec,
        prevRemainingMs: r(rec.prevRemaining * 1000), startLatencyMs: r(clockStart - rec.at),
        index: [before, usePlayer.getState().index], metadata: !!cur && titleNow === cur.title, title: titleNow,
        listened: Math.round(listenedSeconds() * 10) / 10,
        sinceHandoverSec: Math.round((performance.now() - rec.at) / 100) / 10,
        released: from !== activeAudio() && !from.getAttribute("src"), phase: transitionInfo().phase,
        playing: !to.paused && usePlayer.getState().status === "playing" && usePlayer.getState().wantsPlay,
        gain: to.volume, ...(fade ? { fade } : {}),
      });
    }
    // The play counter restarted at the handover: it holds no more than the time since then.
    // (A fixed `< 4` failed the crossfade, which waits ~4.5 s, by timing alone: 3.9 vs 4.2.)
    const ok = handovers.length === 3 && handovers.every((h, i) =>
      h.happened && h.kind === ["gapless", "gapless", "crossfade"][i] && (h.index as number[])[1] === (h.index as number[])[0] + 1
      && h.metadata && h.released && h.playing && h.phase === "idle" && (h.listened as number) <= (h.sinceHandoverSec as number) + 0.3)
      && !!(handovers[2].fade as { ramps?: boolean } | undefined)?.ramps && !!(handovers[2].fade as { bothPlaying?: boolean } | undefined)?.bothPlaying;
    return { ok, muted: activeAudio().muted, handovers };
  } finally {
    usePlayer.getState().setPlayback(saved);
  }
}

async function miniPlayerCheck(s: Step) {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { getCurrentWebviewWindow, WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const me = getCurrentWebviewWindow();
  const replies = new Map<number, Record<string, unknown>>();
  const off = await me.listen<Record<string, unknown>>("mini:selftest-result", (e) => { if (typeof e.payload?.id === "number") replies.set(e.payload.id, e.payload); });
  let n = 0;
  const ask = async (req: Record<string, unknown>, timeoutMs = 4000) => {
    const id = ++n;
    await emitTo("mini", "mini:selftest", { ...req, id });
    for (let t = 0; t < timeoutMs && !replies.has(id); t += 100) await sleep(100);
    return replies.get(id) ?? null;
  };
  const win = getCurrentWindow();
  const out: Record<string, unknown> = {};
  let opened = false;
  try {
    const hellos0 = miniBridgeInfo().hellos;
    await invoke("toggle_mini_player");
    for (let t = 0; t < 10000 && miniBridgeInfo().hellos === hellos0; t += 100) await sleep(100);
    opened = miniBridgeInfo().hellos > hellos0;
    const mini = await WebviewWindow.getByLabel("mini");
    out.visible = (await mini?.isVisible().catch((e) => String(e))) ?? null;
    await sleep(800);
    const report = await ask({ do: "report" });
    const cur = usePlayer.getState().current();
    out.report = report;
    const titleOk = !!report && !!cur && report.title === cur.title;
    const wasPlaying = usePlayer.getState().status === "playing" && !activeAudio().paused;
    await mainWindow.hide(s, 30000); await sleep(300);
    s("mini presses with the main window hidden");
    // Muted media in a hidden window can stall ("waiting" sets the store to loading; Play/Pause
    // then still pauses) or be paused by WebKit (then the press plays). Try to get it playing
    // again; if it won't, the pause/resume checks are skipped and the command path is checked.
    const playingNow = () => usePlayer.getState().status === "playing" && !activeAudio().paused;
    for (let t = 0; wasPlaying && t < 4000 && !playingNow(); t += 100) await sleep(100);
    if (wasPlaying && activeAudio().muted && !playingNow()) {
      usePlayer.getState().play();
      for (let t = 0; t < 3000 && !playingNow(); t += 100) await sleep(100);
    }
    const canCheck = wasPlaying && playingNow();
    const b0 = miniBridgeInfo();
    const pressesBefore = b0.commands - b0.hellos - b0.byes;
    await ask({ do: "click", cmd: "toggle" }); await sleep(900);
    // The bridge records the state the press saw, what it decided (toggleAction) and the state
    // right after, so a failure says which it was: a wrong decision, a press that didn't act,
    // or something undoing it in the 900 ms since (a stale play event, #55).
    const firstToggle = miniBridgeInfo().lastToggle;
    out.firstToggle = firstToggle;
    const expectedFirst = firstToggle?.decision ?? null;
    const decidedRight = !!firstToggle && firstToggle.decision === toggleAction(firstToggle.before.status as never, firstToggle.before.wantsPlay);
    const actedRight = !!firstToggle && (firstToggle.decision === "pause" ? firstToggle.after.paused && !firstToggle.after.wantsPlay : firstToggle.after.wantsPlay);
    const heldRight = expectedFirst === "pause"
      ? activeAudio().paused && usePlayer.getState().status === "paused" && !usePlayer.getState().wantsPlay
      : usePlayer.getState().wantsPlay;
    Object.assign(out, { decidedRight, actedRight, heldRight });
    const firstOk = decidedRight && actedRight && heldRight;
    const paused = activeAudio().paused && usePlayer.getState().status === "paused";
    const shownPaused = (await ask({ do: "state" }))?.status === "paused";
    await ask({ do: "click", cmd: "toggle" }); await sleep(1800);
    const resumed = !activeAudio().paused;
    const target = Math.min(15, Math.max(1, (usePlayer.getState().duration || 30) - 5));
    await ask({ do: "seek", sec: target }); await sleep(900);
    const seeked = Math.abs(activeAudio().currentTime - target) < 3;
    // A malformed command (as if from the mini window) is dropped, not run.
    const rejected0 = miniBridgeInfo().rejected;
    await emitTo("main", MINI_EVENTS.command, { type: "setVolume", v: 0 }); await sleep(300);
    const rejectsBad = miniBridgeInfo().rejected === rejected0 + 1;
    s("mini shows the main window");
    await ask({ do: "click", cmd: "showMain" }); await sleep(800);
    const mainShown = await win.isVisible();
    // Exactly the four sent (toggle, toggle, seek, showMain): a doubled listener in either
    // window doubles every press, and two toggles cancel out.
    // hello/bye are commands too, and a visibilitychange in the mini window can add a pair:
    // only the presses count.
    const presses = (i: ReturnType<typeof miniBridgeInfo>) => i.commands - i.hellos - i.byes;
    const commands = presses(miniBridgeInfo()) - pressesBefore;
    const commandsExact = commands === 4;
    const perms = report?.setOnTop === "ok" && report?.drag === "ok" && report?.sqlDenied === true && report?.commandDenied === true && report?.fsDenied === true;
    // Without playback (the stream didn't start, or muted media stayed paused while hidden)
    // only the command path and the first press's decision are checked.
    // The pause/resume pair is only checked when the first press paused a playing track.
    const playbackOk = firstOk && commandsExact && (canCheck && expectedFirst === "pause" ? paused && shownPaused && resumed && seeked : true);

    // Menu actions reach this page only from Rust (menu.rs `dispatch`): a `menu` event
    // emitted by the mini window does nothing, the real handler does.
    const queueOpen = () => usePlayer.getState().queueOpen;
    const q0 = queueOpen();
    s("menu dispatch");
    await ask({ do: "forgeMenu" }); await sleep(400);
    const forgedMenuIgnored = queueOpen() === q0;
    await invoke("selftest_menu", { id: "queue" }); await sleep(400);
    const menuDispatched = queueOpen() !== q0;
    await invoke("selftest_menu", { id: "queue" }); await sleep(300);
    // Controls items leave the windows alone: with the main window hidden, Play/Pause acts
    // on the player and the main window stays hidden.
    await mainWindow.hide(s, 15000); await sleep(300);
    s("menu play-pause with the main window hidden");
    const st0 = usePlayer.getState().status;
    await invoke("selftest_menu", { id: "play-pause" }); await sleep(900);
    const controlActed = usePlayer.getState().status !== st0;
    const controlKeptHidden = (await win.isVisible()) === false;
    await invoke("selftest_menu", { id: "play-pause" }); await sleep(1500);
    // Controls > Sleep Timer (#70): set and cancelled from the native menu, window still hidden.
    s("menu sleep timer");
    await invoke("selftest_menu", { id: "sleep:30" }); await sleep(400);
    const sleepSet = usePlayer.getState().sleep?.kind === "minutes";
    await invoke("selftest_menu", { id: "sleep:off" }); await sleep(400);
    const sleepMenuOk = sleepSet && usePlayer.getState().sleep === null && (await win.isVisible()) === false;
    await mainWindow.show(); await sleep(300);
    // View → Command Palette (#72): the native item opens the palette in this page.
    s("menu command palette");
    await invoke("selftest_menu", { id: "command-palette" }); await sleep(400);
    const paletteMenuOk = usePalette.getState().open && !!document.querySelector("[data-palette-input]");
    usePalette.getState().hide(); await sleep(100);
    s("close and reshow the mini window");
    // Close Window with the mini window focused hides it (and nothing else), and the bridge
    // stops sending state until the next hello.
    const liveBeforeClose = miniBridgeInfo().live;
    await invoke("selftest_menu", { id: "close-window", focused: "mini" }); await sleep(800);
    const miniClosed = (await mini?.isVisible().catch(() => null)) === false;
    const mainUntouched = await win.isVisible();
    const liveAfterClose = miniBridgeInfo().live;
    const sent0 = miniBridgeInfo().sent;
    const playingWhileHidden = usePlayer.getState().status === "playing";
    await sleep(2500);
    const quietWhileHidden = miniBridgeInfo().sent === sent0;
    // Shown again (the dock button's path): Rust says hello itself, so the stream restarts
    // without relying on WebKit's visibilitychange, and the mini window shows the current track.
    await invoke("toggle_mini_player"); await sleep(600);
    const liveAfterReshow = miniBridgeInfo().live;
    const reshown = await ask({ do: "state" });
    const reshowTitleOk = !!reshown && reshown.title === usePlayer.getState().current()?.title;
    // Close Window on the main window still sends it a close request, which hides it.
    s("close the main window from the menu");
    await mainWindow.arm(15000);
    await invoke("selftest_menu", { id: "close-window", focused: "main" }); await sleep(800);
    const mainCloseHides = (await win.isVisible()) === false;
    out.guardShows = await mainWindow.show(); await sleep(300);
    const menuOk = forgedMenuIgnored && menuDispatched && controlActed && controlKeptHidden && sleepMenuOk && paletteMenuOk;
    const closeOk = liveBeforeClose && miniClosed && mainUntouched && !liveAfterClose && quietWhileHidden && mainCloseHides && liveAfterReshow && reshowTitleOk;
    Object.assign(out, {
      opened, titleOk, wasPlaying, canCheck, firstOk,
      ...(canCheck ? { paused, shownPaused, resumed, seeked } : { paused: "skipped (muted)", shownPaused: "skipped (muted)", resumed: "skipped (muted)", seeked: "skipped (muted)" }),
      rejectsBad, mainShown, commands, commandsExact, perms,
      forgedMenuIgnored, menuDispatched, controlActed, controlKeptHidden, sleepMenuOk, paletteMenuOk,
      liveBeforeClose, miniClosed, mainUntouched, liveAfterClose, playingWhileHidden, quietWhileHidden, liveAfterReshow, reshowTitleOk, mainCloseHides,
      info: miniBridgeInfo(),
    });
    out.ok = opened && out.visible === true && titleOk && perms && playbackOk && rejectsBad && mainShown && menuOk && closeOk;
  } finally {
    off();
    await mainWindow.show().catch(() => undefined);
    if (opened) {
      const mini = await WebviewWindow.getByLabel("mini");
      if (await mini?.isVisible().catch(() => false)) await invoke("toggle_mini_player").catch(() => undefined); // hides it
      await sleep(400);
      out.hiddenAfter = (await mini?.isVisible().catch(() => null)) === false;
      if (!out.hiddenAfter) out.ok = false;
    }
  }
  return out;
}

/**
 * Offline copies (#2) through the real plugins: download ONE track (the album's shortest, one
 * album page refresh at most plus one mp3 through the queue) into this run's offline folder
 * (next to its database, so a BCP_DB_PATH run stays in its scratch folder), check the file
 * and the asset URL, play it (muted) from the file, then remove it again.
 */
async function offlineCheck(core: Core, album: AlbumDetail, s: Step) {
  if (!album) return { ok: false, error: "no album" };
  const out: Record<string, unknown> = {};
  const dir = await invoke<string>("offline_dir").catch((e) => { out.dirError = String(e); return null; });
  out.dir = dir ? dir.split("/").slice(-2).join("/") : null;
  if (!dir || !(await core.offlineStats()).available) return { ok: false, ...out };
  const shortest = album.tracks.filter((t) => t.streamable && t.duration).sort((a, b) => a.duration! - b.duration!)[0];
  if (!shortest) return { ok: false, ...out, error: "no streamable track" };
  out.track = { title: shortest.title, duration: shortest.duration };
  const name = `${shortest.track_id}.mp3`;
  try {
    s("download one track");
    const job = await core.downloadAlbum(album.id, [shortest.id]);
    if (!job) return { ok: false, ...out, error: "nothing queued" };
    for (let i = 0; i < 90; i++) {
      const j = await core.job(job.id);
      if (j && ["done", "failed", "cancelled"].includes(j.status)) { out.job = { status: j.status, done: j.done, failed: j.failed, error: j.error ?? j.items?.find((x) => x.error)?.error ?? null }; break; }
      await sleep(1000);
    }
    const stats = await core.offlineStats();
    out.stats = { tracks: stats.tracks, bytes: stats.bytes };
    out.fileExists = await exists(`${dir}/${name}`);
    const url = await core.localTrackUrl(shortest.id);
    out.url = url?.slice(0, 40) ?? null;
    out.marked = (await core.album(album.id))?.tracks.find((t) => t.id === shortest.id)?.downloaded ?? null;
    if (!url) return { ok: false, ...out };

    s("play from the file");
    usePlayer.getState().playTracks([shortest], 0);
    await sleep(4000);
    const el = activeAudio();
    out.playback = { fromFile: el.src === url, currentTime: el.currentTime, paused: el.paused, error: el.error?.code ?? null, storeError: usePlayer.getState().error };
    s("seek within the file");
    // A seek ahead of what has played: the asset protocol must answer Range requests.
    const target = Math.min(30, (shortest.duration ?? 60) / 2);
    usePlayer.getState().seek(target);
    await sleep(1500);
    out.afterSeek = { target, currentTime: el.currentTime, error: el.error?.code ?? null };
    usePlayer.getState().pause();
  } finally {
    s("remove the copy");
    usePlayer.getState().clearQueue();
    await core.removeTrackDownloads([shortest.id]).catch((e) => { out.removeError = String(e); });
    out.fileAfterRemove = await exists(`${dir}/${name}`).catch((e) => String(e));
    out.tracksAfterRemove = (await core.offlineStats()).tracks;
  }
  const pb = out.playback as { fromFile: boolean; currentTime: number; error: number | null };
  const seek = out.afterSeek as { target: number; currentTime: number; error: number | null };
  const seekOk = seek.currentTime >= seek.target - 0.5 && seek.error == null;
  out.ok = (out.job as { status?: string })?.status === "done" && out.fileExists === true && out.marked === true
    && pb.fromFile && pb.currentTime > 1 && pb.error == null && seekOk
    && out.fileAfterRemove === false && out.tracksAfterRemove === 0;
  return out;
}

const TIMEOUT = Symbol("timeout");

/** `p`, or TIMEOUT after `ms` (timed in Rust too, see sleep). */
function within<T>(ms: number, p: Promise<T>): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);
}

type Core = Awaited<ReturnType<typeof getCore>>;
type AlbumDetail = Awaited<ReturnType<Core["album"]>>;

export async function runSelfTest() {
  captureConsole();
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const core = await getCore();
  // With the display asleep or locked every window is covered, so WebKit treats the page as
  // hidden even while the window is shown, and with only muted media it can stop running the
  // page altogether (#67): no timers, no IPC replies.
  out.keepAwake = await mainWindow.keepAwake().catch((e) => String(e));
  // settings.key='selftest_progress' says which block (and step) the run is in, so a run that
  // never writes its result still says where it stopped. Written in order, never awaited.
  let progressWrites: Promise<unknown> = Promise.resolve();
  const progress = (p: Record<string, unknown>) => {
    const row = { ...p, visibility: document.visibilityState, at: new Date().toISOString() };
    progressWrites = progressWrites.then(() => core.setSetting("selftest_progress", row)).catch(() => undefined);
  };
  const timedOut: string[] = [];
  /**
   * One block of the run with its own timeout: on timeout it records where it was
   * (`{ status: "timeout", step }`), makes sure the main window is shown again and the run
   * moves on; the abandoned block stops at its next step (Step throws). A throw is recorded
   * as `{ ok: false, error }`.
   */
  const block = async <T>(name: string, fn: (s: Step) => Promise<T>, timeoutMs = 60_000): Promise<T | Record<string, unknown>> => {
    let step = "start";
    let abandoned = false;
    const s: Step = (label) => {
      if (abandoned) throw new Abandoned(`${name} timed out`);
      step = label;
      progress({ block: name, step });
    };
    progress({ block: name, step, ...(name === "import" ? { keepAwake: out.keepAwake } : {}) });
    const t0 = performance.now();
    try {
      const r = await within(timeoutMs, fn(s));
      if (r !== TIMEOUT) return r;
      abandoned = true;
      timedOut.push(name);
      await within(5000, mainWindow.show()).catch(() => undefined);
      return { ok: false, status: "timeout", step, afterMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: `${String(e)}\n${(e as Error)?.stack ?? ""}`.trim(), step };
    }
  };
  const hasOk = (v: unknown): v is { ok: unknown } => !!v && typeof v === "object" && "ok" in v;

  // Plays above this id were made by the run (the player or the history check) and are
  // removed at the end, so the selftest never leaves anything in the real history.
  const playsBefore = await core.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM plays").then((r) => r?.m ?? 0, () => null);
  try {
    let album = null as AlbumDetail;
    let playable: Track[] = [];
    out.import = await block("import", async (s) => {
      const job = await core.import({ url: ALBUM });
      s("wait for the import job");
      for (let i = 0; i < 90; i++) {
        const j = await core.job(job.id);
        if (j && (j.status === "done" || j.status === "failed")) { out.job = { status: j.status, done: j.done, failed: j.failed, error: j.error }; break; }
        await sleep(1000);
      }
      const albums = await core.albums();
      out.albums = albums.length;
      album = await core.album(albums.find((a) => a.url === ALBUM)?.id ?? albums[0].id);
      out.tracks = album?.tracks.length ?? 0;
      playable = album?.tracks.filter((t) => t.streamable) ?? [];
      return { ok: !!album && playable.length > 0 };
    }, 120_000);
    out.libraryFilter = await block("libraryFilter", () => libraryFilterCheck(core, album));
    out.tags = await block("tags", () => tagsCheck(core, album));
    out.albumNotes = await block("albumNotes", () => albumNotesCheck(core, album?.id));
    out.history = await block("history", () => historyCheck(core, album));
    out.audio = await block("audio", async (s) => {
      usePlayer.getState().playTracks(playable, 0);
      s("playing for 7 s");
      await sleep(7000);
      return { visibility: document.visibilityState, currentTime: activeAudio().currentTime, paused: activeAudio().paused, readyState: activeAudio().readyState, error: activeAudio().error?.code ?? null, src: activeAudio().src.slice(0, 48), storeStatus: usePlayer.getState().status, storeError: usePlayer.getState().error };
    }, 30_000);
    out.mediaSession = await block("mediaSession", (s) => mediaSessionCheck(s), 30_000);
    out.miniPlayer = await block("miniPlayer", (s) => miniPlayerCheck(s), 90_000);
    out.audioAfterNext = await block("next", async (s) => {
      usePlayer.getState().next();
      s("playing for 4 s");
      await sleep(4000);
      return { currentTime: activeAudio().currentTime, paused: activeAudio().paused, index: usePlayer.getState().index, title: usePlayer.getState().current()?.title };
    }, 20_000);
    out.hiddenPlayback = await block("hiddenPlayback", (s) => hiddenPlaybackCheck(s), 60_000);
    out.transitions = await block("transitions", (s) => transitionCheck(playable, s), 150_000);
    out.offline = await block("offline", (s) => offlineCheck(core, album, s), 120_000);
    // Nothing below needs playback; stopping here keeps the track from reaching a counted play.
    usePlayer.getState().pause();
    out.playlist = await block("playlist", async () => {
      const pl = await core.createPlaylist("Selftest");
      await core.addToPlaylist(pl.id, playable.slice(0, 3).map((t) => t.id));
      const got = await core.playlist(pl.id);
      await core.deletePlaylist(pl.id);
      return { tracks: got?.tracks.length, art_ids: got?.art_ids };
    }, 30_000);
    out.playState = await block("playState", async () => {
      await sleep(1500);
      return core.playState().then((s) => ({ queue: s.queue.length, index: s.queue_index, pos: s.position_sec }));
    }, 30_000);
    // The volume curve (#36): the saved state keeps the gain (what older builds read), and
    // the element's gain is the curve of the slider position.
    out.volume = await block("volume", () => core.playState().then((s) => {
      const position = usePlayer.getState().volume;
      const gain = positionToGain(position);
      const ok = Math.abs(s.volume - gain) < 1e-9 && Math.abs(activeAudio().volume - gain) < 1e-6;
      return { ok, saved: s.volume, position, gain: activeAudio().volume };
    }), 30_000);
    out.search = await block("search", async () => {
      const results = await core.search("illuminati hotties");
      return { count: results.length, inLibrary: results.filter((r) => r.in_library).length };
    });
    out.browse = await block("browse", async () => {
      const browse = await core.browse("https://illuminatihotties.bandcamp.com");
      return { releases: browse.items.length, band: browse.band?.name, inLibrary: browse.items.filter((i) => i.album_id).length, firstTitle: browse.items[0]?.title };
    });
    // Bandcamp Radio (#44): one show-list request through the http scope; a second call must
    // come from the page cache (a day). The episode page and its audio are left to the tests.
    out.radio = await block("radio", async () => {
      const before = await core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_cache WHERE url = 'https://bandcamp.com/radio'");
      const shows = await core.radioShows();
      const again = await core.radioShows();
      const cached = await core.db.get<{ fetched_at: number }>("SELECT fetched_at FROM page_cache WHERE url = 'https://bandcamp.com/radio'");
      const first = shows[0];
      // The http plugin must hand back a 3xx unfollowed, with its Location (how an episode's
      // stream_redirect is resolved). /radio?show=<id> 302s to the episode page: one request.
      const location = first ? await core.queue.resolveRedirect(`https://bandcamp.com/radio?show=${first.id}`).catch((e) => `error: ${String(e)}`) : null;
      const ok = shows.length > 0 && again.length === shows.length && !!cached && !!first &&
        first.id > 0 && !!first.title && !!first.program && /^https:\/\/bandcamp\.com\/radio\//.test(first.url) &&
        location === first.url;
      return { ok, count: shows.length, cachedBefore: before?.n ?? 0, location, first: first ? { id: first.id, title: first.title, program: first.program, date: first.date, image: !!first.image_id, url: first.url } : null };
    }, 30_000);
    out.newReleases = await block("newReleases", () => newReleasesCheck(core, album));
    out.preorder = await block("preorder", () => preorderCheck(core, album));
    // Custom artist domain: the http scope must allow the custom host (it 303s to name.bandcamp.com),
    // and the library must key the album by the custom-domain URL from data-tralbum.
    // Only albums that are new by id get deleted afterwards, so the real library is left as it was.
    out.customDomain = await block("customDomain", async (s) => {
      const before = new Set((await core.albums()).map((x) => x.id));
      return core.import({ url: CUSTOM_ALBUM }).then(async (cj) => {
        let status: string | undefined = "timeout", error: unknown = null;
        try {
          s("wait for the import job");
          for (let i = 0; i < 60; i++) {
            const j = await core.job(cj.id);
            if (j && (j.status === "done" || j.status === "failed")) { status = j.status; error = j.error ?? j.items?.[0]?.error ?? null; break; }
            await sleep(1000);
          }
          const a = (await core.albums()).find((x) => x.url === CUSTOM_ALBUM);
          // force=true re-fetches the stored (custom-domain) URL through the plugin.
          s("fresh stream URL and browse");
          const first = a ? (await core.album(a.id))?.tracks.find((t) => t.streamable) : undefined;
          const refreshed = first ? await core.getFreshStreamUrl(first.id, true).then((u) => new URL(u.url).hostname, (e) => String(e)) : null;
          const b = await core.browse(CUSTOM_ARTIST).then((r) => ({ url: r.url, releases: r.items.length, inLibrary: r.items.filter((i) => i.album_id).length }), (e) => String(e));
          return { status, error, stored: !!a, refreshedStreamHost: refreshed, browse: b };
        } finally {
          if (status === "timeout") await core.cancelJob(cj.id).catch(() => false);
          for (const x of await core.albums()) if (!before.has(x.id)) await core.deleteAlbum(x.id);
        }
      }, (e) => String(e));
    }, 150_000);
    // The http scope's deny list must beat the custom-domain allow patterns for private hosts
    // (a redirect hop is checked the same way). The scope check happens before any connection.
    out.denyScope = await block("denyScope", async () => {
      const denied = ["https://127.0.0.1/album/x", "https://192.168.1.1/music", "https://[::1]/track/x", "https://nas.lan/album/x", "https://router/album/x"];
      const deniedResults = await Promise.all(denied.map((u) =>
        tauriFetch(u, { maxRedirections: 0, connectTimeout: 2000 }).then((r) => `fetched ${r.status}`, (e) => String(e))));
      return {
        allRejected: deniedResults.every((r) => r.includes("not allowed on the configured scope")),
        results: Object.fromEntries(denied.map((u, i) => [u, deniedResults[i]])),
      };
    }, 30_000);
    out.syncGuards = await block("syncGuards", () => checkSyncGuards(core));
    out.libraryFile = await block("libraryFile", () => libraryFileCheck(core));
    out.fsScope = await block("fsScope", () => fsScopeCheck());
    out.collection = SELFTEST_FAN ? await block("collection", async () => {
      const page = parseFanPage(await core.queue.fetchText(fanPageUrl(SELFTEST_FAN)));
      // POST to bandcamp.com/api/... through the http scope, two items only.
      const api = parseFanItemsResponse(await core.queue.fetchText(FAN_ITEMS_ENDPOINT.collection, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ fan_id: page.fan_id, older_than_token: page.collection.next, count: 2 }),
      }));
      const pick = page.collection.items[0];
      const before = new Set((await core.albums()).map((x) => x.id));
      let imported: unknown = null;
      if (pick) {
        const j = await core.import({ url: pick.fetch_url });
        try {
          for (let i = 0; i < 60; i++) {
            const r = await core.job(j.id);
            if (r && (r.status === "done" || r.status === "failed")) { imported = { status: r.status, error: r.error ?? r.items?.[0]?.error ?? null }; break; }
            await sleep(1000);
          }
          const a = (await core.albums()).find((x) => x.bandcamp_id === pick.bandcamp_id && x.item_type === pick.item_type);
          imported = { ...(imported as object), stored: !!a, canonical: a?.url === pick.url };
        } finally {
          for (const x of await core.albums()) if (!before.has(x.id)) await core.deleteAlbum(x.id);
        }
      }
      // The new table and the filtered queries run against the app's library database (library-dev.db here).
      const [purchased, wishlist] = await Promise.all([core.albums("added", "purchased"), core.albums("added", "wishlist")]);
      return {
        fanId: page.fan_id > 0, counts: [page.collection.count, page.wishlist.count], firstBatch: [page.collection.items.length, page.wishlist.items.length],
        apiItems: api.items.length, apiMore: api.more, imported, filters: { purchased: purchased.length, wishlist: wishlist.length },
      };
    }, 150_000) : "skipped (set VITE_SELFTEST_FAN to a public fan username)";
    // The challenge cooldown is read from settings through the SQL plugin; null unless Bandcamp challenged us.
    out.challengeUntil = await block("challengeUntil", () => core.challengeUntil().then((u) => (u ? new Date(u).toISOString() : null)), 10_000);
    // Window permissions the menu bar and close-to-hide rely on.
    out.window = await block("window", (s) => windowCheck(s), 30_000);
    out.appearance = await block("appearance", (s) => appearanceCheck(s), 15_000);
    // startDragging needs a live mouse-down to do anything, but a missing
    // capability rejects the call outright; record what it says.
    out.dragPermission = await block("dragPermission", () => getCurrentWindow().startDragging().then(() => "ok", (e) => String(e)), 10_000);
    // The menu-bar command is registered and granted. Resends the current state, so the icon
    // stays as the setting has it (with the setting off, nothing appears on the screen).
    out.menuBar = await block("menuBar", () => resendMenuBar().then(() => ({ ok: true })), 10_000);
    // The notification plugin is registered and granted. Read-only: nothing is posted and no
    // permission is requested.
    out.notifications = await block("notifications", () => invoke("plugin:notification|is_permission_granted").then((granted) => ({ ok: true, granted })), 10_000);
    // Overall ok needs every block that reports its own `ok` to pass (a timed-out or thrown
    // block reports ok: false). The listed blocks must be present as objects: one caught and
    // stored as a string threw.
    const required = ["import", "libraryFilter", "albumNotes", "history", "hiddenPlayback", "mediaSession", "miniPlayer", "transitions", "offline", "syncGuards", "newReleases", "preorder", "libraryFile", "fsScope", "window", "appearance"];
    const failed = Object.entries(out)
      .filter(([k, v]) => required.includes(k) || hasOk(v))
      .filter(([, v]) => (v as { ok?: unknown } | null)?.ok !== true)
      .map(([k]) => k);
    if (!failed.includes("denyScope") && !(out.denyScope as { allRejected?: boolean }).allRejected) failed.push("denyScope");
    out.failedBlocks = failed;
    out.ok = failed.length === 0;
  } catch (e) {
    out.ok = false;
    // WebKit's stack has no message line, so keep both.
    out.error = `${String(e)}\n${(e as Error)?.stack ?? ""}`;
  } finally {
    if (playsBefore != null) {
      out.playsRemoved = await within(10_000, core.db.run("DELETE FROM plays WHERE id > ?", [playsBefore])).then((r) => (r === TIMEOUT ? "timeout" : r.changes), (e) => String(e));
    }
  }
  out.timedOut = timedOut;
  // How many times the Rust guard had to show a hidden window the page didn't (#67).
  out.windowGuardShows = await within(5000, mainWindow.show()).then((n) => (n === TIMEOUT ? "timeout" : n), (e) => String(e));
  out.console = consoleLog.slice();
  out.finishedAt = new Date().toISOString();
  progress({ block: "done" });
  await core.setSetting("selftest", out).catch((e) => core.setSetting("selftest", { ok: false, finishedAt: out.finishedAt, error: `result not saved: ${String(e)}` }));
  console.log("[selftest]", JSON.stringify(out));
  // Closing only hides the window now (playback continues), so quit explicitly.
  await sleep(500);
  await exit(0).catch((e) => core.setSetting("selftest_close_error", String(e)));
}
