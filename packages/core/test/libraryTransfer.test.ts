import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { createPlaylist, addTracks, getPlaylist, listPlaylists, deletePlaylist } from "../src/db/repos/playlists.js";
import { getSetting, setSetting } from "../src/db/repos/settings.js";
import { setIdentityCookie, setUsername, getAccount } from "../src/services/account.js";
import { recomputeOwned } from "../src/db/repos/fanItems.js";
import { setMuted, isMuted } from "../src/db/repos/releases.js";
import { countPending, clearPending } from "../src/db/repos/importPending.js";
import { createCore } from "../src/core.js";
import { parseTheme } from "../src/theme/schema.js";
import type { Db } from "../src/db/Db.js";
import * as jobs from "../src/db/repos/jobs.js";
import { DEFAULT_THEME, PRESETS } from "../src/theme/presets.js";
import {
  exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport, backupDatabase,
  LIBRARY_EXPORT_VERSION, MAX_LIBRARY_FILE_CHARS, MAX_PLAYLIST_ENTRIES, MAX_PLAYS, type LibraryExport,
} from "../src/services/libraryTransfer.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "../src/types.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ALBUM = "https://music.zoekeating.com/album/snowmelt-ep";
const COOKIE = "7%09abcDEF%3D%3D%09%7B%22id%22%3A1%7D";

/** A fake Bandcamp serving the two album fixtures. `gate` holds a URL's answer until released. */
function fakeBandcamp(gate?: { url: string; open: Promise<void> }, missing: string[] = []) {
  const calls: string[] = [];
  const pages: Record<string, () => string> = { [ALBUM]: () => fixture("album"), [CUSTOM_ALBUM]: () => fixture("custom-album") };
  for (const m of missing) delete pages[m];
  const fetch = async (url: string) => {
    calls.push(url);
    if (gate && url === gate.url) await gate.open;
    const p = pages[url];
    return p ? new Response(p(), { status: 200 }) : new Response("not here", { status: 404 });
  };
  return { fetch, calls };
}

function runnerFor(db: NodeDb, f = fakeBandcamp()) {
  return new JobRunner(db, new FetchQueue(f.fetch, 0));
}

async function waitJob(db: NodeDb, id: number): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const j = (await jobs.getJob(db, id))!;
    if (j.status !== "queued" && j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
}

const tracksOf = async (db: NodeDb, url: string) =>
  db.select<{ id: number; track_id: number; title: string }>("SELECT t.id, t.track_id, t.title FROM tracks t JOIN albums a ON a.id = t.album_id WHERE a.url = ? ORDER BY t.track_num", [url]);

/** Playlists by name with their tracks' Bandcamp ids in order. */
async function playlistShape(db: NodeDb) {
  const out: Record<string, number[]> = {};
  for (const p of await listPlaylists(db)) out[p.name] = (await getPlaylist(db, p.id))!.tracks.map((t) => t.track_id);
  return out;
}
const playsShape = async (db: NodeDb) =>
  db.select<{ track_id: number; played_at: string; seconds_listened: number }>(
    "SELECT t.track_id, p.played_at, p.seconds_listened FROM plays p JOIN tracks t ON t.id = p.track_id ORDER BY p.played_at, t.track_id");

/** A source library: two albums, a playlist across both, history, settings, account, flags and release preferences. */
async function sourceLibrary(): Promise<NodeDb> {
  const db = new NodeDb();
  const a = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
  await upsertTralbum(db, parseTralbumPage(fixture("custom-album"), 0));
  const at = await tracksOf(db, ALBUM);
  const ct = await tracksOf(db, CUSTOM_ALBUM);
  const mix = await createPlaylist(db, "Mix");
  await addTracks(db, mix.id, [at[2].id, ct[0].id, at[0].id]);
  await createPlaylist(db, "Empty");
  for (const [tid, when, sec] of [[at[0].id, "2026-10-01 10:00:00", 120], [at[0].id, "2026-10-02 11:00:00", 90], [ct[1].id, "2026-10-03 12:00:00", 200]] as const) {
    await db.run("INSERT INTO plays (track_id, played_at, seconds_listened) VALUES (?, ?, ?)", [tid, when, sec]);
  }
  await setSetting(db, "theme", { theme: PRESETS[1], basePreset: PRESETS[1].name });
  await setSetting(db, "library_view", { sort: "title", filter: "purchased" });
  await setSetting(db, "release_check", { enabled: false });
  await setUsername(db, "examplefan");
  await setIdentityCookie(db, COOKIE);
  const album = (await db.get<{ item_type: string; bandcamp_id: number; artist_id: number }>("SELECT item_type, bandcamp_id, artist_id FROM albums WHERE id = ?", [a]))!;
  await db.run("INSERT INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, sync_job) VALUES ('collection', ?, ?, ?, ?, 1), ('wishlist', ?, ?, ?, ?, 1)",
    [album.item_type, album.bandcamp_id, ALBUM, ALBUM, album.item_type, album.bandcamp_id, ALBUM, ALBUM]);
  await recomputeOwned(db);
  const custom = (await db.get<{ artist_id: number }>("SELECT artist_id FROM albums WHERE url = ?", [CUSTOM_ALBUM]))!;
  await setMuted(db, custom.artist_id, true);
  await db.run("INSERT INTO artist_releases (artist_id, url, item_type, title, status) VALUES (?, 'https://illuminatihotties.bandcamp.com/album/old-one', 'album', 'Old one', 'dismissed')", [album.artist_id]);
  return db;
}

let src: NodeDb;
let file: string;
let data: LibraryExport;
beforeEach(async () => {
  src = await sourceLibrary();
  file = JSON.stringify(await exportLibrary(src, { appVersion: "0.4.0" }));
  const parsed = parseLibraryExport(file);
  if (!parsed.data) throw new Error(parsed.error);
  data = parsed.data;
});

describe("library export", () => {
  it("carries albums, playlists, history, settings and the username, never the cookie, caches or stream URLs", async () => {
    expect(data.version).toBe(LIBRARY_EXPORT_VERSION);
    expect(data.albums.map((a) => a.url).sort()).toEqual([ALBUM, CUSTOM_ALBUM].sort());
    expect(data.albums.find((a) => a.url === ALBUM)).toMatchObject({ owned: true, wishlisted: true });
    expect(data.playlists.map((p) => [p.name, p.tracks.length])).toEqual([["Mix", 3], ["Empty", 0]]);
    expect(data.history).toHaveLength(3);
    expect(data.account.username).toBe("examplefan");
    expect(data.new_releases).toMatchObject({ checks_enabled: false, muted: [expect.objectContaining({ name: "Zoe Keating" })], dismissed: [expect.objectContaining({ title: "Old one" })] });
    expect(file).not.toContain(COOKIE);
    for (const word of ["identity", "bandcamp_sync", "stream_url", "bcbits.com", "page_cache", "ambient1", "challenge"]) expect(file).not.toContain(word);
  });

  it("leaves history out when asked", async () => {
    expect((await exportLibrary(src, { history: false })).history).toBeNull();
  });

  it("keeps the same library id across exports", async () => {
    expect((await exportLibrary(src)).library_id).toBe(data.library_id);
  });
});

describe("library import", () => {
  it("writes a system theme so older builds accept it, and restores it as system", async () => {
    const sys = { ...DEFAULT_THEME, mode: "system" as const };
    await setSetting(src, "theme", { theme: sys, basePreset: "Dusk" });
    const out = JSON.parse(JSON.stringify(await exportLibrary(src)));
    // What a build before system themes checks: mode is dark or light, the pair is extra.
    expect(["dark", "light"]).toContain(out.settings.theme.theme.mode);
    expect(out.settings.theme.mode).toBe("system");
    const dst = new NodeDb();
    const r = await importLibrary(dst, runnerFor(dst, fakeBandcamp()), parseLibraryExport(JSON.stringify(out)).data!);
    await waitJob(dst, r.job!.id);
    expect(await getSetting(dst, "theme")).toEqual({ theme: sys, basePreset: "Dusk" });
  });

  it("round-trips into an empty library: albums, playlist order, history, settings, flags and preferences", async () => {
    const dst = new NodeDb();
    const f = fakeBandcamp();
    const runner = runnerFor(dst, f);
    const preview = await previewLibraryImport(dst, data);
    expect(preview).toMatchObject({ albums: { total: 2, new: 2, present: 0 }, playlists: { total: 2, new: 2, present: 0, renamed: [] }, plays: 3, account: { username: "examplefan", applies: true } });

    const r = await importLibrary(dst, runner, data, { label: "library.json" });
    expect(r).toMatchObject({ queued: 2, playlistsCreated: 2 });
    expect(r.job?.kind).toBe("library");
    expect((await waitJob(dst, r.job!.id)).status).toBe("done");
    expect(f.calls.sort()).toEqual([ALBUM, CUSTOM_ALBUM].sort());

    expect((await dst.select<{ url: string }>("SELECT url FROM albums ORDER BY url")).map((a) => a.url)).toEqual([ALBUM, CUSTOM_ALBUM].sort());
    expect(await playlistShape(dst)).toEqual(await playlistShape(src));
    expect(await playsShape(dst)).toEqual(await playsShape(src));
    for (const key of ["theme", "library_view", "release_check"]) expect(await getSetting(dst, key)).toEqual(await getSetting(src, key));
    const acc = await getAccount(dst);
    expect(acc).toMatchObject({ username: "examplefan", hasCookie: false });
    expect((await dst.get<{ owned: number }>("SELECT owned FROM albums WHERE url = ?", [ALBUM]))!.owned).toBe(1);
    expect(await dst.get("SELECT 1 AS x FROM fan_items WHERE list = 'wishlist'")).not.toBeNull();
    const zoe = (await dst.get<{ artist_id: number }>("SELECT artist_id FROM albums WHERE url = ?", [CUSTOM_ALBUM]))!;
    expect(await isMuted(dst, zoe.artist_id)).toBe(true);
    expect(await dst.get("SELECT status FROM artist_releases WHERE url = 'https://illuminatihotties.bandcamp.com/album/old-one'")).toEqual({ status: "dismissed" });
    expect(await countPending(dst)).toEqual({ tracks: 0, plays: 0, other: 0, notes: 0 });
    expect(await dst.get("SELECT 1 AS x FROM settings WHERE key = 'bandcamp_identity'")).toBeNull();
  });

  it("creates playlists right away and fills them, in order, as their albums arrive", async () => {
    const dst = new NodeDb();
    let open!: () => void;
    const f = fakeBandcamp({ url: CUSTOM_ALBUM, open: new Promise<void>((r) => { open = r; }) });
    const r = await importLibrary(dst, runnerFor(dst, f), data);
    // Wait until the first album is in and the second is being fetched.
    for (let i = 0; i < 400 && !f.calls.includes(CUSTOM_ALBUM); i++) await new Promise((res) => setTimeout(res, 5));
    const mix = (await listPlaylists(dst)).find((p) => p.name === "Mix")!;
    const partial = (await getPlaylist(dst, mix.id))!.tracks.map((t) => t.track_id);
    const want = data.playlists[0].tracks.map((t) => t.track_id);
    expect(partial).toEqual([want[0], want[2]]);
    expect((await countPending(dst)).tracks).toBe(1);
    open();
    await waitJob(dst, r.job!.id);
    expect((await getPlaylist(dst, mix.id))!.tracks.map((t) => t.track_id)).toEqual(want);
  });

  it("is idempotent: importing the same file again adds nothing and queues nothing", async () => {
    const dst = new NodeDb();
    const f = fakeBandcamp();
    const runner = runnerFor(dst, f);
    await waitJob(dst, (await importLibrary(dst, runner, data)).job!.id);
    const before = { playlists: await playlistShape(dst), plays: await playsShape(dst), albums: await dst.select("SELECT id, url FROM albums ORDER BY id") };
    expect(await previewLibraryImport(dst, data)).toMatchObject({ albums: { new: 0, present: 2 }, playlists: { new: 0, present: 2 } });
    const again = await importLibrary(dst, runner, data);
    expect(again).toMatchObject({ job: null, queued: 0, playlistsCreated: 0 });
    // A second export of the same library is recognised too.
    const again2 = await importLibrary(dst, runner, (await exportLibrary(src)) as LibraryExport);
    expect(again2).toMatchObject({ job: null, playlistsCreated: 0 });
    expect(await playlistShape(dst)).toEqual(before.playlists);
    expect(await playsShape(dst)).toEqual(before.plays);
    expect(await dst.select("SELECT id, url FROM albums ORDER BY id")).toEqual(before.albums);
    expect(f.calls).toHaveLength(2);
  });

  it("re-importing while the first import still runs queues no album twice", async () => {
    const dst = new NodeDb();
    let open!: () => void;
    const f = fakeBandcamp({ url: ALBUM, open: new Promise<void>((r) => { open = r; }) });
    const runner = runnerFor(dst, f);
    const first = await importLibrary(dst, runner, data);
    const second = await importLibrary(dst, runner, data);
    expect(second.job).toBeNull();
    open();
    await waitJob(dst, first.job!.id);
    expect(f.calls.filter((u) => u === ALBUM)).toHaveLength(1);
  });

  it("importing into the library that made the file changes nothing", async () => {
    const before = { playlists: await playlistShape(src), plays: await playsShape(src) };
    const r = await importLibrary(src, runnerFor(src), data);
    expect(r).toMatchObject({ job: null, playlistsCreated: 0 });
    expect(await playlistShape(src)).toEqual(before.playlists);
    expect(await playsShape(src)).toEqual(before.plays);
  });

  it("never overwrites a playlist with the same name: the import gets a suffix", async () => {
    const dst = new NodeDb();
    await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    const mine = await createPlaylist(dst, "Mix");
    await addTracks(dst, mine.id, [(await tracksOf(dst, ALBUM))[5].id]);
    await createPlaylist(dst, "mix (2)");
    const preview = await previewLibraryImport(dst, data);
    expect(preview.playlists.renamed).toEqual([{ from: "Mix", to: "Mix (3)" }]);
    expect(preview.albums).toMatchObject({ new: 1, present: 1 });
    const r = await importLibrary(dst, runnerFor(dst), data);
    await waitJob(dst, r.job!.id);
    const shape = await playlistShape(dst);
    expect(shape.Mix).toEqual([(await tracksOf(dst, ALBUM))[5].track_id]);
    expect(shape["mix (2)"]).toEqual([]);
    expect(shape["Mix (3)"]).toEqual(data.playlists[0].tracks.map((t) => t.track_id));
  });

  it("a same-named playlist with the same tracks counts as already there", async () => {
    const dst = new NodeDb();
    await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    await upsertTralbum(dst, parseTralbumPage(fixture("custom-album"), 0));
    const p = await createPlaylist(dst, "Mix");
    const byBc = new Map((await dst.select<{ id: number; track_id: number }>("SELECT id, track_id FROM tracks")).map((t) => [t.track_id, t.id]));
    await addTracks(dst, p.id, data.playlists[0].tracks.map((t) => byBc.get(t.track_id!)!));
    expect((await previewLibraryImport(dst, data)).playlists).toMatchObject({ new: 1, present: 1, renamed: [] });
  });

  it("merges history without duplicating plays already here", async () => {
    const dst = new NodeDb();
    await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    const t0 = (await tracksOf(dst, ALBUM))[0];
    await dst.run("INSERT INTO plays (track_id, played_at, seconds_listened) VALUES (?, '2026-10-01 10:00:00', 120), (?, '2026-09-01 09:00:00', 60)", [t0.id, t0.id]);
    const r = await importLibrary(dst, runnerFor(dst), data);
    expect(r.resolved.plays).toBe(1); // the custom album's play waits for it
    await waitJob(dst, r.job!.id);
    expect((await playsShape(dst)).map((p) => p.played_at)).toEqual(["2026-09-01 09:00:00", "2026-10-01 10:00:00", "2026-10-02 11:00:00", "2026-10-03 12:00:00"]);
  });

  it("leaves history and settings alone when those options are off", async () => {
    const dst = new NodeDb();
    const r = await importLibrary(dst, runnerFor(dst), data, { history: false, settings: false });
    await waitJob(dst, r.job!.id);
    expect(await playsShape(dst)).toEqual([]);
    expect(await getSetting(dst, "theme")).toBeNull();
    expect(await getSetting(dst, "library_view")).toBeNull();
  });

  it("keeps another account's username and flags out", async () => {
    const dst = new NodeDb();
    await setUsername(dst, "someoneelse");
    expect((await previewLibraryImport(dst, data)).account).toEqual({ username: "examplefan", applies: false, marks: 1 });
    const r = await importLibrary(dst, runnerFor(dst), data);
    await waitJob(dst, r.job!.id);
    expect((await getAccount(dst)).username).toBe("someoneelse");
    expect(await dst.get("SELECT 1 AS x FROM fan_items")).toBeNull();
  });
});

describe("library file validation", () => {
  it("rejects files that aren't library exports, with a sentence", () => {
    expect(parseLibraryExport("{not json").error).toMatch(/isn't valid JSON/);
    expect(parseLibraryExport(JSON.stringify({ name: "Midnight", version: 1 })).error).toMatch(/isn't a Campusboard library export/);
    expect(parseLibraryExport("[]").error).toMatch(/isn't a Campusboard library export/);
  });

  it("rejects a file from a newer version with a clear message", () => {
    const r = parseLibraryExport(JSON.stringify({ ...data, version: LIBRARY_EXPORT_VERSION + 1 }));
    expect(r.error).toMatch(/newer version of Campusboard/);
    expect(parseLibraryExport(JSON.stringify({ ...data, version: "1" })).error).toMatch(/version is missing or invalid/);
  });

  it("rejects damaged files and says where", () => {
    const noAlbums: Record<string, unknown> = { ...data };
    delete noAlbums.albums;
    expect(parseLibraryExport(JSON.stringify(noAlbums)).error).toMatch(/damaged \(albums: Required\)/);
    const badUrl = { ...data, albums: [{ ...data.albums[0], url: "javascript:alert(1)" }] };
    expect(parseLibraryExport(JSON.stringify(badUrl)).error).toMatch(/damaged \(albums\.0\.url/);
    const badTheme = { ...data, settings: { ...data.settings, theme: { theme: { ...PRESETS[0], radius: 999 } } } };
    expect(parseLibraryExport(JSON.stringify(badTheme)).error).toMatch(/settings\.theme/);
  });
});

describe("database backup", () => {
  it("writes a complete copy with VACUUM INTO while the library is open", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bcp-backup-"));
    try {
      const out = path.join(dir, "backup.db");
      await backupDatabase(src, out);
      expect(existsSync(out)).toBe(true);
      const copy = new NodeDb(out);
      expect((await copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM albums"))!.n).toBe(2);
      expect((await copy.get<{ n: number }>("SELECT COUNT(*) AS n FROM plays"))!.n).toBe(3);
      copy.raw.close();
      // SQLite refuses to overwrite: the app always writes to a fresh file.
      await expect(backupDatabase(src, out)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hostile and oversized files", () => {
  it("never queues, fetches or stores LAN, IP-literal, port or mismatched addresses", async () => {
    const dst = new NodeDb();
    const f = fakeBandcamp();
    const album = (url: string, id: number, extra: Partial<LibraryExport["albums"][number]> = {}) =>
      ({ url, item_type: "album" as const, bandcamp_id: id, title: "x", artist: "x", artist_url: null, band_id: null, owned: true, wishlisted: false, fetch_url: null, ...extra });
    const real = data.albums.find((a) => a.url === ALBUM)!;
    const custom = data.albums.find((a) => a.url === CUSTOM_ALBUM)!;
    const hostile: LibraryExport = {
      ...data,
      albums: [
        // A real album whose fetch URL points at some other release: the mark is dropped.
        { ...real, fetch_url: "https://other.bandcamp.com/album/y" },
        // A custom-domain album whose fetch URL isn't on bandcamp.com: dropped too.
        { ...custom, owned: true, fetch_url: "https://music.zoekeating.com/album/snowmelt-ep" },
        album("https://192.168.1.10/album/x", 9001),
        album("https://10.0.0.1/album/x", 9002, { fetch_url: "https://10.0.0.1/album/x" }),
        album("https://nas.lan/album/x", 9003),
        album("https://evil.example.com:8443/album/x", 9004),
        album("https://localhost/album/x", 9005),
        album("https://router/album/x", 9006),
        album("https://bandcamp.com/album/x", 9007),
      ],
      new_releases: {
        ...data.new_releases,
        dismissed: [
          ...data.new_releases.dismissed,
          { band_id: 1, url: "https://10.0.0.1/album/z", item_type: "album", title: "z", art_id: null, artist_override: null },
          { band_id: 1, url: "https://evil.example.com/admin/panel", item_type: "album", title: "z", art_id: null, artist_override: null },
          { band_id: 1, url: "https://nas.local/track/z", item_type: "track", title: "z", art_id: null, artist_override: null },
        ],
      },
    };
    const parsed = parseLibraryExport(JSON.stringify(hostile));
    expect(parsed.error).toBeUndefined();
    const preview = await previewLibraryImport(dst, parsed.data!);
    expect(preview.albums).toMatchObject({ total: 9, new: 2, invalid: 7 });
    const r = await importLibrary(dst, runnerFor(dst, f), parsed.data!);
    await waitJob(dst, r.job!.id);
    expect(f.calls.sort()).toEqual([ALBUM, CUSTOM_ALBUM].sort());
    expect((await dst.select<{ url: string }>("SELECT url FROM job_items")).map((x) => x.url).sort()).toEqual([ALBUM, CUSTOM_ALBUM].sort());
    expect(await dst.select("SELECT url FROM albums WHERE url NOT IN (?, ?)", [ALBUM, CUSTOM_ALBUM])).toEqual([]);
    // No marks survive: one mismatched, one off bandcamp.com, the rest invalid.
    expect(await dst.select("SELECT * FROM fan_items")).toEqual([]);
    expect((await dst.get<{ owned: number }>("SELECT owned FROM albums WHERE url = ?", [ALBUM]))!.owned).toBe(0);
    const stored = [
      ...(await dst.select<{ url: string }>("SELECT url FROM artist_releases")).map((x) => x.url),
      ...(await dst.select<{ url: string | null }>("SELECT release_url AS url FROM import_pending")).map((x) => x.url),
    ];
    expect(stored.filter((u) => u && !u.startsWith("https://illuminatihotties.bandcamp.com/"))).toEqual([]);
  });

  it("keeps a mark whose fetch URL is the same release on name.bandcamp.com", async () => {
    const dst = new NodeDb();
    const custom = data.albums.find((a) => a.url === CUSTOM_ALBUM)!;
    const file = { ...data, albums: [{ ...custom, owned: true, fetch_url: "https://zoekeating.bandcamp.com/album/snowmelt-ep" }] };
    await waitJob(dst, (await importLibrary(dst, runnerFor(dst), file)).job!.id);
    expect(await dst.select("SELECT list, url, fetch_url FROM fan_items")).toEqual([
      { list: "collection", url: CUSTOM_ALBUM, fetch_url: "https://zoekeating.bandcamp.com/album/snowmelt-ep" },
    ]);
    expect((await dst.get<{ owned: number }>("SELECT owned FROM albums WHERE url = ?", [CUSTOM_ALBUM]))!.owned).toBe(1);
  });

  it("refuses files over the size and entry caps, and malformed usernames, with a sentence", () => {
    expect(parseLibraryExport(" ".repeat(MAX_LIBRARY_FILE_CHARS + 1)).error).toMatch(/too large to import \(over 50 MB\)/);
    const ref = data.playlists[0].tracks[0];
    const per = Math.ceil((MAX_PLAYLIST_ENTRIES + 1) / 2);
    const many = { ...data, playlists: [0, 1].map((i) => ({ key: `k:${i}`, name: `p${i}`, created_at: "x", tracks: Array(per).fill(ref) })) };
    expect(parseLibraryExport(JSON.stringify(many)).error).toMatch(/playlists hold more than 200,000 tracks/);
    const play = data.history![0];
    expect(parseLibraryExport(JSON.stringify({ ...data, history: Array(MAX_PLAYS + 1).fill(play) })).error).toMatch(/too large to import/);
    expect(parseLibraryExport(JSON.stringify({ ...data, account: { username: "not a user/../x" } })).error).toMatch(/account\.username: not a Bandcamp username/);
  });

  it("refuses theme background file names that leave the backgrounds folder", () => {
    const bg = (value: string) => parseTheme({ ...PRESETS[0], background: { source: "file", value, blur: 0, dim: 0 } });
    expect(bg("1760000000-photo.jpg").theme).toBeDefined();
    for (const bad of ["../library.db", "backgrounds/../x", "..", ".hidden", "a/b.png"]) expect(bg(bad).error, bad).toMatch(/plain file name/);
    const file = { ...data, settings: { ...data.settings, theme: { theme: { ...PRESETS[0], background: { source: "file", value: "../library.db", blur: 0, dim: 0 } } } } };
    expect(parseLibraryExport(JSON.stringify(file)).error).toMatch(/settings\.theme/);
  });
});

describe("waiting entries", () => {
  it("a failed album keeps its playlist entries and plays waiting, and Stop waiting forgets them", async () => {
    const dst = new NodeDb();
    const r = await importLibrary(dst, runnerFor(dst, fakeBandcamp(undefined, [CUSTOM_ALBUM])), data);
    const job = await waitJob(dst, r.job!.id);
    expect(job).toMatchObject({ status: "done", done: 1, failed: 1 });
    // Mix keeps its custom-album entry waiting, and the custom album's play waits too.
    expect(await countPending(dst)).toEqual({ tracks: 1, plays: 1, other: 1, notes: 0 });
    const mix = (await listPlaylists(dst)).find((p) => p.name === "Mix")!;
    expect((await getPlaylist(dst, mix.id))!.tracks).toHaveLength(2);
    // Importing the file again once the album is reachable fills the gap in place.
    const again = await importLibrary(dst, runnerFor(dst), data);
    await waitJob(dst, again.job!.id);
    expect((await getPlaylist(dst, mix.id))!.tracks.map((t) => t.track_id)).toEqual(data.playlists[0].tracks.map((t) => t.track_id));
    expect(await countPending(dst)).toEqual({ tracks: 0, plays: 0, other: 0, notes: 0 });
  });

  it("Stop waiting forgets everything still pending", async () => {
    const dst = new NodeDb();
    const r = await importLibrary(dst, runnerFor(dst, fakeBandcamp(undefined, [ALBUM, CUSTOM_ALBUM])), data);
    await waitJob(dst, r.job!.id);
    const before = await countPending(dst);
    expect(before.tracks + before.plays + before.other).toBeGreaterThan(0);
    expect(await clearPending(dst)).toBe(before.tracks + before.plays + before.other);
    expect(await countPending(dst)).toEqual({ tracks: 0, plays: 0, other: 0, notes: 0 });
  });

  it("deleting an imported playlist drops its waiting entries and its link", async () => {
    const dst = new NodeDb();
    const r = await importLibrary(dst, runnerFor(dst, fakeBandcamp(undefined, [ALBUM, CUSTOM_ALBUM])), data);
    await waitJob(dst, r.job!.id);
    expect((await countPending(dst)).tracks).toBe(3);
    const mix = (await listPlaylists(dst)).find((p) => p.name === "Mix")!;
    await deletePlaylist(dst, mix.id);
    expect((await countPending(dst)).tracks).toBe(0);
    expect(await dst.get("SELECT 1 AS x FROM imported_playlists WHERE playlist_id = ?", [mix.id])).toBeNull();
    // With foreign keys off (the sqlite3 CLI), vacuumOrphans sweeps the same rows.
    const empty = (await listPlaylists(dst)).find((p) => p.name === "Empty")!;
    await dst.run("INSERT INTO import_pending (kind, dedupe_key, playlist_id, position, album_url, track_title) VALUES ('playlist_track', 'pl:x', ?, 0, ?, 't')", [empty.id, ALBUM]);
    dst.raw.exec("PRAGMA foreign_keys = OFF");
    await dst.run("DELETE FROM playlists WHERE id = ?", [empty.id]);
    dst.raw.exec("PRAGMA foreign_keys = ON");
    await vacuumOrphans(dst);
    expect(await dst.select("SELECT * FROM import_pending WHERE playlist_id = ?", [empty.id])).toEqual([]);
    expect(await dst.select("SELECT * FROM imported_playlists WHERE playlist_id = ?", [empty.id])).toEqual([]);
  });

  it("clearing history also forgets plays still waiting, so they don't come back", async () => {
    const dst = new NodeDb();
    let open!: () => void;
    const f = fakeBandcamp({ url: CUSTOM_ALBUM, open: new Promise<void>((res) => { open = res; }) });
    const core = createCore({ db: dst, fetch: f.fetch });
    const r = await importLibrary(dst, runnerFor(dst, f), data);
    for (let i = 0; i < 400 && !f.calls.includes(CUSTOM_ALBUM); i++) await new Promise((res) => setTimeout(res, 5));
    expect((await countPending(dst)).plays).toBe(1);
    await core.clearHistory();
    open();
    await waitJob(dst, r.job!.id);
    expect(await core.playCount()).toBe(0);
  });

  it("an import interrupted between claiming and linking a playlist doesn't duplicate it", async () => {
    const dst = new NodeDb();
    // Fail the first link write, as if the app quit right after creating the playlist.
    let failed = false;
    const flaky: Db = {
      select: (sql, p) => dst.select(sql, p),
      get: (sql, p) => dst.get(sql, p),
      run: async (sql, p) => {
        if (!failed && sql.startsWith("UPDATE imported_playlists")) { failed = true; throw new Error("killed"); }
        return dst.run(sql, p);
      },
    };
    await expect(importLibrary(flaky, runnerFor(dst), data)).rejects.toThrow("killed");
    expect((await listPlaylists(dst)).map((p) => p.name)).toEqual(["Mix"]);
    const r = await importLibrary(dst, runnerFor(dst), data);
    await waitJob(dst, r.job!.id);
    const shape = await playlistShape(dst);
    expect(Object.keys(shape).sort()).toEqual(["Empty", "Mix"]);
    expect(shape.Mix).toEqual(data.playlists[0].tracks.map((t) => t.track_id));
  });
});
