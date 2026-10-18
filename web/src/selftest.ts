// Dev-only end-to-end check that runs inside the Tauri window when VITE_SELFTEST=1.
// Results are written to the `settings` table (key "selftest") so a script outside
// the app can read them from the SQLite file.
import { getCore } from "./api/core";
import { listenedSeconds, usePlayer } from "./player/store";
import { audioEl } from "./player/audio";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/api/app";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { FAN_ITEMS_ENDPOINT, fanPageUrl, parseFanItemsResponse, parseFanPage, repos, type FanItem } from "@bc/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
 * Window permissions the menu bar and close-to-hide rely on. Each step runs on its own, so a
 * throw is recorded with diagnostics (which window methods exist, what was thrown) instead
 * of aborting the run, and the window is always shown again at the end.
 */
async function windowCheck() {
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
  await step("minimize", () => win.minimize()); await sleep(400);
  const minimized = await step("isMinimized", () => win.isMinimized());
  await step("unminimize", () => win.unminimize()); await sleep(400);
  await step("hide", () => win.hide()); await sleep(300);
  const visibleWhileHidden = await step("isVisibleHidden", () => win.isVisible());
  await step("show", () => win.show());
  await step("setFocus", () => win.setFocus()); await sleep(300);
  const visibleAgain = await step("isVisibleAgain", () => win.isVisible());
  const focused = await step("isFocused", () => win.isFocused());
  const result = { maximized, minimized, hidden: visibleWhileHidden === false, visibleAgain, focused, errors };
  // `focused` is informational: a background terminal can keep focus from the window.
  return { ok: Object.keys(errors).length === 0 && maximized === true && minimized === true && result.hidden && visibleAgain === true, ...result };
}

/**
 * Background listening: hide the window (what closing it does) for 20 s while a track plays,
 * and measure how often timeupdate still arrives and whether listening history keeps
 * accumulating. Observes the audio element without changing it.
 *
 * status "stalled" (the playhead didn't move: not playing, or buffering) says nothing about
 * the counter, so it doesn't fail the run; "failed" means the playhead moved but listened
 * time didn't keep up.
 */
async function hiddenPlaybackCheck() {
  const win = getCurrentWindow();
  if (audioEl.paused) return { ok: true, status: "stalled", reason: "not playing" };
  let last = performance.now();
  let maxGapMs = 0;
  let reports = 0;
  const onTick = () => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    reports++;
  };
  audioEl.addEventListener("timeupdate", onTick);
  try {
    await win.hide();
    const visibility = document.visibilityState;
    last = performance.now();
    const t0 = audioEl.currentTime, l0 = listenedSeconds(), w0 = last;
    await sleep(20000);
    const wallSec = (performance.now() - w0) / 1000;
    const mediaSec = audioEl.currentTime - t0;
    const listenedSec = listenedSeconds() - l0;
    const r = (x: number) => Math.round(x * 100) / 100;
    const status = mediaSec < 1 ? "stalled" : listenedSec >= mediaSec * 0.9 ? "ok" : "failed";
    return {
      ok: status !== "failed", status,
      visibility, wallSec: r(wallSec), mediaSec: r(mediaSec), listenedSec: r(listenedSec), reports, maxGapMs: Math.round(maxGapMs),
    };
  } finally {
    audioEl.removeEventListener("timeupdate", onTick);
    await win.show();
    await win.setFocus();
  }
}

export async function runSelfTest() {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const core = await getCore();
  // Plays above this id were made by the run (the player or the history check) and are
  // removed at the end, so the selftest never leaves anything in the real history.
  const playsBefore = await core.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM plays").then((r) => r?.m ?? 0, () => null);
  try {
    const job = await core.import({ url: ALBUM });
    for (let i = 0; i < 90; i++) {
      const j = await core.job(job.id);
      if (j && (j.status === "done" || j.status === "failed")) { out.job = { status: j.status, done: j.done, failed: j.failed, error: j.error }; break; }
      await sleep(1000);
    }
    const albums = await core.albums();
    out.albums = albums.length;
    const album = await core.album(albums.find((a) => a.url === ALBUM)?.id ?? albums[0].id);
    out.tracks = album?.tracks.length ?? 0;
    out.libraryFilter = await libraryFilterCheck(core, album);
    out.history = await historyCheck(core, album).catch((e) => ({ ok: false, error: String(e) }));
    const playable = album?.tracks.filter((t) => t.streamable) ?? [];
    usePlayer.getState().playTracks(playable, 0);
    await sleep(7000);
    out.audio = { currentTime: audioEl.currentTime, paused: audioEl.paused, readyState: audioEl.readyState, error: audioEl.error?.code ?? null, src: audioEl.src.slice(0, 48), storeStatus: usePlayer.getState().status, storeError: usePlayer.getState().error };
    usePlayer.getState().next();
    await sleep(4000);
    out.audioAfterNext = { currentTime: audioEl.currentTime, paused: audioEl.paused, index: usePlayer.getState().index, title: usePlayer.getState().current()?.title };
    out.hiddenPlayback = await hiddenPlaybackCheck().catch((e) => ({ ok: false, status: "failed", error: String(e) }));
    // Nothing below needs playback; stopping here keeps the track from reaching a counted play.
    usePlayer.getState().pause();
    const pl = await core.createPlaylist("Selftest");
    await core.addToPlaylist(pl.id, playable.slice(0, 3).map((t) => t.id));
    const got = await core.playlist(pl.id);
    out.playlist = { tracks: got?.tracks.length, art_ids: got?.art_ids };
    await core.deletePlaylist(pl.id);
    await sleep(1500);
    out.playState = await core.playState().then((s) => ({ queue: s.queue.length, index: s.queue_index, pos: s.position_sec }));
    const results = await core.search("illuminati hotties");
    out.search = { count: results.length, inLibrary: results.filter((r) => r.in_library).length };
    const browse = await core.browse("https://illuminatihotties.bandcamp.com");
    out.browse = { releases: browse.items.length, band: browse.band?.name, inLibrary: browse.items.filter((i) => i.album_id).length, firstTitle: browse.items[0]?.title };
    out.newReleases = await newReleasesCheck(core, album).catch((e) => ({ ok: false, error: String(e) }));
    // Custom artist domain: the http scope must allow the custom host (it 303s to name.bandcamp.com),
    // and the library must key the album by the custom-domain URL from data-tralbum.
    // Only albums that are new by id get deleted afterwards, so the real library is left as it was.
    const before = new Set((await core.albums()).map((x) => x.id));
    out.customDomain = await core.import({ url: CUSTOM_ALBUM }).then(async (cj) => {
      let status: string | undefined = "timeout", error: unknown = null;
      try {
        for (let i = 0; i < 60; i++) {
          const j = await core.job(cj.id);
          if (j && (j.status === "done" || j.status === "failed")) { status = j.status; error = j.error ?? j.items?.[0]?.error ?? null; break; }
          await sleep(1000);
        }
        const a = (await core.albums()).find((x) => x.url === CUSTOM_ALBUM);
        // force=true re-fetches the stored (custom-domain) URL through the plugin.
        const first = a ? (await core.album(a.id))?.tracks.find((t) => t.streamable) : undefined;
        const refreshed = first ? await core.getFreshStreamUrl(first.id, true).then((s) => new URL(s.url).hostname, (e) => String(e)) : null;
        const b = await core.browse(CUSTOM_ARTIST).then((r) => ({ url: r.url, releases: r.items.length, inLibrary: r.items.filter((i) => i.album_id).length }), (e) => String(e));
        return { status, error, stored: !!a, refreshedStreamHost: refreshed, browse: b };
      } finally {
        if (status === "timeout") await core.cancelJob(cj.id).catch(() => false);
        for (const x of await core.albums()) if (!before.has(x.id)) await core.deleteAlbum(x.id);
      }
    }, (e) => String(e));
    // The http scope's deny list must beat the custom-domain allow patterns for private hosts
    // (a redirect hop is checked the same way). The scope check happens before any connection.
    const denied = ["https://127.0.0.1/album/x", "https://192.168.1.1/music", "https://[::1]/track/x", "https://nas.lan/album/x", "https://router/album/x"];
    const deniedResults = await Promise.all(denied.map((u) =>
      tauriFetch(u, { maxRedirections: 0, connectTimeout: 2000 }).then((r) => `fetched ${r.status}`, (e) => String(e))));
    out.denyScope = {
      allRejected: deniedResults.every((r) => r.includes("not allowed on the configured scope")),
      results: Object.fromEntries(denied.map((u, i) => [u, deniedResults[i]])),
    };
    out.syncGuards = await checkSyncGuards(core).catch((e) => String(e));
    out.collection = SELFTEST_FAN ? await (async () => {
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
      // The new table and the filtered queries run against the real library.db.
      const [purchased, wishlist] = await Promise.all([core.albums("added", "purchased"), core.albums("added", "wishlist")]);
      return {
        fanId: page.fan_id > 0, counts: [page.collection.count, page.wishlist.count], firstBatch: [page.collection.items.length, page.wishlist.items.length],
        apiItems: api.items.length, apiMore: api.more, imported, filters: { purchased: purchased.length, wishlist: wishlist.length },
      };
    })().catch((e) => String(e)) : "skipped (set VITE_SELFTEST_FAN to a public fan username)";
    // The challenge cooldown is read from settings through the SQL plugin; null unless Bandcamp challenged us.
    out.challengeUntil = await core.challengeUntil().then((u) => (u ? new Date(u).toISOString() : null), (e) => String(e));
    out.mediaSession = "mediaSession" in navigator;
    // Window permissions the menu bar and close-to-hide rely on.
    out.window = await windowCheck();
    // startDragging needs a live mouse-down to do anything, but a missing
    // capability rejects the call outright; record what it says.
    out.dragPermission = await getCurrentWindow().startDragging().then(() => "ok", (e) => String(e));
    // Overall ok needs every block that reports its own `ok` to pass. The listed blocks must
    // be present as objects: one caught and stored as a string threw.
    const required = ["libraryFilter", "history", "hiddenPlayback", "syncGuards", "newReleases", "window"];
    const failed = Object.entries(out)
      .filter(([k, v]) => required.includes(k) || (!!v && typeof v === "object" && "ok" in v))
      .filter(([, v]) => (v as { ok?: unknown } | null)?.ok !== true)
      .map(([k]) => k);
    if (!(out.denyScope as { allRejected?: boolean }).allRejected) failed.push("denyScope");
    out.failedBlocks = failed;
    out.ok = failed.length === 0;
  } catch (e) {
    out.ok = false;
    // WebKit's stack has no message line, so keep both.
    out.error = `${String(e)}\n${(e as Error)?.stack ?? ""}`;
  } finally {
    if (playsBefore != null) {
      out.playsRemoved = await core.db.run("DELETE FROM plays WHERE id > ?", [playsBefore]).then((r) => r.changes, (e) => String(e));
    }
  }
  out.finishedAt = new Date().toISOString();
  await core.setSetting("selftest", out);
  console.log("[selftest]", JSON.stringify(out));
  // Closing only hides the window now (playback continues), so quit explicitly.
  await sleep(500);
  await exit(0).catch((e) => core.setSetting("selftest_close_error", String(e)));
}
