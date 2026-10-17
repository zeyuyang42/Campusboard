// Dev-only end-to-end check that runs inside the Tauri window when VITE_SELFTEST=1.
// Results are written to the `settings` table (key "selftest") so a script outside
// the app can read them from the SQLite file.
import { getCore } from "./api/core";
import { usePlayer } from "./player/store";
import { audioEl } from "./player/audio";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/api/app";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ARTIST = "https://music.zoekeating.com";
const CUSTOM_ALBUM = `${CUSTOM_ARTIST}/album/snowmelt-ep`;

export async function runSelfTest() {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const core = await getCore();
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
    const playable = album?.tracks.filter((t) => t.streamable) ?? [];
    usePlayer.getState().playTracks(playable, 0);
    await sleep(7000);
    out.audio = { currentTime: audioEl.currentTime, paused: audioEl.paused, readyState: audioEl.readyState, error: audioEl.error?.code ?? null, src: audioEl.src.slice(0, 48), storeStatus: usePlayer.getState().status, storeError: usePlayer.getState().error };
    usePlayer.getState().next();
    await sleep(4000);
    out.audioAfterNext = { currentTime: audioEl.currentTime, paused: audioEl.paused, index: usePlayer.getState().index, title: usePlayer.getState().current()?.title };
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
    // The challenge cooldown is read from settings through the SQL plugin; null unless Bandcamp challenged us.
    out.challengeUntil = await core.challengeUntil().then((u) => (u ? new Date(u).toISOString() : null), (e) => String(e));
    out.mediaSession = "mediaSession" in navigator;
    // Window permissions the menu bar and close-to-hide rely on.
    const win = getCurrentWindow();
    await win.toggleMaximize(); await sleep(400);
    const maximized = await win.isMaximized();
    await win.toggleMaximize(); await sleep(400);
    await win.minimize(); await sleep(400);
    const minimized = await win.isMinimized();
    await win.unminimize(); await sleep(400);
    await win.hide(); await sleep(300);
    const hidden = !(await win.isVisible());
    await win.show(); await win.setFocus(); await sleep(300);
    out.window = { maximized, minimized, hidden, visibleAgain: await win.isVisible(), focused: await win.isFocused() };
    // startDragging needs a live mouse-down to do anything, but a missing
    // capability rejects the call outright; record what it says.
    out.dragPermission = await win.startDragging().then(() => "ok", (e) => String(e));
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e as Error)?.stack ?? e);
  }
  out.finishedAt = new Date().toISOString();
  await core.setSetting("selftest", out);
  console.log("[selftest]", JSON.stringify(out));
  // Closing only hides the window now (playback continues), so quit explicitly.
  await sleep(500);
  await exit(0).catch((e) => core.setSetting("selftest_close_error", String(e)));
}
