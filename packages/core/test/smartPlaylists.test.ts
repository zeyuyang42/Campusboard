import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import {
  addTracks, createPlaylist, createSmartPlaylist, deletePlaylist, getPlaylist, listPlaylists, playlistsContaining, reorder,
} from "../src/db/repos/playlists.js";
import {
  evaluateSmartRule, getSmartRule, parseRuleJson, parseSmartRule, setSmartRule, summarizeSmartRule, SmartRuleError,
  SMART_DAYS_MAX, SMART_LIMIT_MAX, SMART_TEXT_MAX, type SmartRule,
} from "../src/db/repos/smartPlaylists.js";
import { exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport } from "../src/services/libraryTransfer.js";

let db: NodeDb;
let nextId = 1;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString().replace("T", " ").slice(0, 19);

function artist(name: string): number {
  const id = nextId++;
  db.raw.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (?, ?, ?, ?)").run(id, id, name, `https://a${id}.bandcamp.com`);
  return id;
}

interface AlbumOpts { owned?: boolean; tracks?: string[]; rating?: number; playedDaysAgo?: number; wishlist?: boolean; downloaded?: boolean }

function album(artistId: number, title: string, tags: string[], o: AlbumOpts = {}): number {
  const id = nextId++;
  db.raw.prepare(
    `INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, tags_json, owned, art_id, fetched_at, created_at)
     VALUES (?, ?, 'album', ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00', ?)`,
  ).run(id, id, artistId, title, `https://x.bandcamp.com/album/${id}`, JSON.stringify(tags), o.owned ? 1 : 0, 1000 + id, `2026-01-${String(id).padStart(2, "0")} 00:00:00`);
  (o.tracks ?? ["One"]).forEach((t, i) => {
    db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, track_num, streamable, local_path) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id * 100 + i, id, t, i + 1, o.downloaded && i === 0 ? `/x/${id}.mp3` : null);
  });
  if (o.rating) db.raw.prepare("INSERT INTO album_notes (album_id, rating, updated_at) VALUES (?, ?, '2026-01-01 00:00:00')").run(id, o.rating);
  if (o.playedDaysAgo !== undefined) {
    db.raw.prepare("INSERT INTO plays (track_id, played_at, seconds_listened) SELECT id, ?, 60 FROM tracks WHERE album_id = ? ORDER BY track_num LIMIT 1").run(ago(o.playedDaysAgo), id);
  }
  if (o.wishlist) {
    db.raw.prepare("INSERT INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, title, artist, sync_job) VALUES ('wishlist', 'album', ?, ?, ?, ?, 'x', 0)").run(id, `https://x.bandcamp.com/album/${id}`, `https://x.bandcamp.com/album/${id}`, title);
  }
  return id;
}

const rule = (r: Partial<SmartRule> = {}): SmartRule => parseSmartRule(r)!;
const albumsOf = async (r: Partial<SmartRule>) => [...new Set((await evaluateSmartRule(db, rule(r))).map((t) => t.album_title))];

beforeEach(() => {
  db = new NodeDb();
  nextId = 1;
  const a = artist("Aphex");
  const b = artist("Boards");
  // created_at follows the id, so "added" (newest first) is Bare, Calm, Pulse, Drift.
  album(a, "Drift", ["ambient"], { owned: true, tracks: ["Haze", "Tide"], rating: 5, playedDaysAgo: 2 });
  album(a, "Pulse", ["techno"], { rating: 3, playedDaysAgo: 100, downloaded: true });
  album(b, "Calm", ["Ambient"], { tracks: ["Haze Two"], rating: 4, wishlist: true });
  album(b, "Bare", []);
});

describe("smart playlist rules (#84)", () => {
  it("fills defaults, trims text and drops empty strings and unknown keys", () => {
    expect(parseSmartRule({})).toEqual({ show: "all", minRating: 0, sort: "added" });
    expect(parseSmartRule({ tag: "  ambient ", text: "  ", extra: 1, sort: "rating" })).toEqual({ show: "all", minRating: 0, sort: "rating", tag: "ambient" });
  });

  it("rejects values outside the bounds", () => {
    const bad: unknown[] = [
      null, "x", { show: "everything" }, { sort: "random" }, { minRating: 6 }, { minRating: -1 }, { minRating: 2.5 },
      { text: "x".repeat(SMART_TEXT_MAX + 1) }, { tag: "x".repeat(SMART_TEXT_MAX + 1) },
      { playedWithinDays: 0 }, { notPlayedWithinDays: SMART_DAYS_MAX + 1 }, { playedWithinDays: 1.5 },
      { limit: 0 }, { limit: SMART_LIMIT_MAX + 1 }, { limit: "10" },
    ];
    for (const b of bad) expect(parseSmartRule(b), JSON.stringify(b)).toBeNull();
    expect(parseSmartRule({ minRating: 5, playedWithinDays: SMART_DAYS_MAX, limit: SMART_LIMIT_MAX })).not.toBeNull();
  });

  it("reads damaged stored JSON as no rule", () => {
    expect(parseRuleJson("{")).toBeNull();
    expect(parseRuleJson('{"minRating":9}')).toBeNull();
    expect(parseRuleJson(null)).toBeNull();
  });
});

describe("evaluating a rule (#84)", () => {
  it("with no criteria lists the whole library in the Library's order", async () => {
    expect(await albumsOf({})).toEqual(["Bare", "Calm", "Pulse", "Drift"]);
    const t = await evaluateSmartRule(db, rule());
    expect(t.map((x) => x.title)).toEqual(["One", "Haze Two", "One", "Haze", "Tide"]);
  });

  it("applies each Show filter", async () => {
    expect(await albumsOf({ show: "purchased" })).toEqual(["Drift"]);
    expect(await albumsOf({ show: "wishlist" })).toEqual(["Calm"]);
    expect(await albumsOf({ show: "downloaded" })).toEqual(["Pulse"]);
    expect(await albumsOf({ show: "rated" })).toEqual(["Calm", "Pulse", "Drift"]);
  });

  it("applies the minimum rating, tag and text", async () => {
    expect(await albumsOf({ minRating: 4 })).toEqual(["Calm", "Drift"]);
    expect(await albumsOf({ tag: "AMBIENT" })).toEqual(["Calm", "Drift"]);
    expect(await albumsOf({ text: "haze" })).toEqual(["Calm", "Drift"]);
    expect(await albumsOf({ text: "boards" })).toEqual(["Bare", "Calm"]);
  });

  it("applies played and not played within N days, by any of the album's tracks", async () => {
    expect(await albumsOf({ playedWithinDays: 7 })).toEqual(["Drift"]);
    expect(await albumsOf({ playedWithinDays: 365 })).toEqual(["Pulse", "Drift"]);
    expect(await albumsOf({ notPlayedWithinDays: 90 })).toEqual(["Bare", "Calm", "Pulse"]);
    // Played in the last year but not in the last 90 days.
    expect(await albumsOf({ playedWithinDays: 365, notPlayedWithinDays: 90 })).toEqual(["Pulse"]);
  });

  it("combines criteria, sorts and limits tracks", async () => {
    expect(await albumsOf({ show: "rated", minRating: 4, tag: "ambient" })).toEqual(["Calm", "Drift"]);
    expect(await albumsOf({ minRating: 3, sort: "rating" })).toEqual(["Drift", "Calm", "Pulse"]);
    expect(await albumsOf({ sort: "title" })).toEqual(["Bare", "Calm", "Drift", "Pulse"]);
    const t = await evaluateSmartRule(db, rule({ sort: "rating", limit: 3 }));
    expect(t.map((x) => x.title)).toEqual(["Haze", "Tide", "Haze Two"]);
    expect(await summarizeSmartRule(db, rule({ sort: "rating", limit: 3 }))).toEqual({ track_count: 3, art_ids: [1003, 1005] });
    expect(await albumsOf({ show: "purchased", notPlayedWithinDays: 7 })).toEqual([]);
    expect(await albumsOf({ show: "purchased", notPlayedWithinDays: 1 })).toEqual(["Drift"]);
  });
});

describe("smart playlists in the playlist repo (#84)", () => {
  it("creates, lists, opens, edits and deletes one; its tracks are never stored", async () => {
    const p = await createSmartPlaylist(db, " Top rated ", { minRating: 4 });
    expect(p).toMatchObject({ name: "Top rated", smart: true, rule: { minRating: 4 }, track_count: 3, art_ids: [1005, 1003] });
    const listed = (await listPlaylists(db, { summaries: true })).find((x) => x.id === p.id)!;
    expect(listed).toMatchObject({ smart: true, track_count: 3, art_ids: [1005, 1003] });
    // Without summaries (the sidebar, the picker) the rule isn't evaluated.
    expect((await listPlaylists(db)).find((x) => x.id === p.id)).toMatchObject({ smart: true, track_count: undefined, art_ids: [] });

    const open = (await getPlaylist(db, p.id))!;
    expect(open.tracks.map((t) => t.title)).toEqual(["Haze Two", "Haze", "Tide"]);
    expect(open.track_count).toBe(3);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM playlist_tracks").get()).toEqual({ n: 0 });

    // Evaluated again on every open: a newly rated album joins.
    db.raw.prepare("INSERT INTO album_notes (album_id, rating, updated_at) VALUES (6, 4, '2026-01-01 00:00:00')").run();
    expect((await getPlaylist(db, p.id))!.tracks.map((t) => t.album_title)[0]).toBe("Bare");

    expect(await setSmartRule(db, p.id, { minRating: 5 })).toBe(true);
    expect(await getSmartRule(db, p.id)).toEqual(rule({ minRating: 5 }));
    await expect(setSmartRule(db, p.id, { minRating: 9 })).rejects.toBeInstanceOf(SmartRuleError);
    expect(await setSmartRule(db, 999, { minRating: 1 })).toBe(false);
    // An ordinary playlist never turns smart and keeps its tracks.
    const plain = await createPlaylist(db, "Plain");
    await addTracks(db, plain.id, [1]);
    expect(await setSmartRule(db, plain.id, { minRating: 1 })).toBe(false);
    expect(await getPlaylist(db, plain.id)).toMatchObject({ smart: false, track_count: 1 });
    await deletePlaylist(db, plain.id);

    expect(await deletePlaylist(db, p.id)).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM smart_playlists").get()).toEqual({ n: 0 });
  });

  it("refuses a bad rule or name without creating anything", async () => {
    await expect(createSmartPlaylist(db, "x", { limit: 0 })).rejects.toBeInstanceOf(SmartRuleError);
    await expect(createSmartPlaylist(db, "  ", {})).rejects.toThrow();
    expect(await listPlaylists(db)).toEqual([]);
  });

  it("takes no tracks: adding, reordering and the picker's check marks leave it alone", async () => {
    const p = await createSmartPlaylist(db, "All", {});
    await addTracks(db, p.id, [1, 2]);
    await reorder(db, p.id, [1]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM playlist_tracks").get()).toEqual({ n: 0 });
    expect(await playlistsContaining(db, [1])).toEqual(new Set());
    // An ordinary playlist still takes them.
    const plain = await createPlaylist(db, "Plain");
    await addTracks(db, plain.id, [1, 2]);
    expect((await getPlaylist(db, plain.id))!).toMatchObject({ smart: false, rule: null, track_count: 2 });
  });

  it("reads a damaged rule as an empty smart playlist, and vacuumOrphans sweeps orphaned rules", async () => {
    const p = await createSmartPlaylist(db, "Damaged", {});
    db.raw.prepare("UPDATE smart_playlists SET rule_json = '{' WHERE playlist_id = ?").run(p.id);
    expect(await getPlaylist(db, p.id)).toMatchObject({ smart: true, rule: null, tracks: [] });
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.raw.prepare("DELETE FROM playlists WHERE id = ?").run(p.id);
    await vacuumOrphans(db);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM smart_playlists").get()).toEqual({ n: 0 });
  });

  it("migration 0011 is safe to re-run over a library that has it", async () => {
    const p = await createSmartPlaylist(db, "Kept", { minRating: 2 });
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/migrations");
    db.raw.exec(readFileSync(path.join(dir, "0011_smart_playlists.sql"), "utf8"));
    expect(await getSmartRule(db, p.id)).toEqual(rule({ minRating: 2 }));
  });
});

describe("smart playlists in a library file (#84)", () => {
  const runner = (d: NodeDb) => new JobRunner(d, new FetchQueue(async () => new Response("no", { status: 404 }), 0));

  async function source() {
    const src = new NodeDb();
    const a = await upsertTralbum(src, parseTralbumPage(fixture("album"), 0));
    const pl = await createPlaylist(src, "Mix");
    const t = await src.select<{ id: number }>("SELECT id FROM tracks WHERE album_id = ? ORDER BY track_num LIMIT 2", [a]);
    await addTracks(src, pl.id, t.map((x) => x.id));
    await createSmartPlaylist(src, "Favourites", { minRating: 4, tag: "rock", sort: "rating", limit: 50 });
    return src;
  }

  it("exports rules (not tracks) and an import recreates them, once", async () => {
    const out = await exportLibrary(await source());
    expect(out.playlists.map((p) => p.name)).toEqual(["Mix"]);
    expect(out.smart_playlists).toEqual([expect.objectContaining({ name: "Favourites", rule: rule({ minRating: 4, tag: "rock", sort: "rating", limit: 50 }) })]);

    const dst = new NodeDb();
    await createPlaylist(dst, "Favourites"); // an ordinary playlist with the same name
    const data = parseLibraryExport(JSON.stringify(out)).data!;
    expect((await previewLibraryImport(dst, data)).playlists).toMatchObject({ total: 2, new: 2, renamed: [{ from: "Favourites", to: "Favourites (2)" }] });
    const r = await importLibrary(dst, runner(dst), data);
    expect(r.playlistsCreated).toBe(2);
    const smart = (await listPlaylists(dst)).filter((p) => p.smart);
    expect(smart).toEqual([expect.objectContaining({ name: "Favourites (2)", rule: rule({ minRating: 4, tag: "rock", sort: "rating", limit: 50 }) })]);

    // Importing the same file again adds nothing.
    expect((await importLibrary(dst, runner(dst), data)).playlistsCreated).toBe(0);
    expect((await listPlaylists(dst)).filter((p) => p.smart)).toHaveLength(1);
  });

  it("recognises the same smart playlist by name and rule in another library", async () => {
    const out = await exportLibrary(await source());
    const dst = new NodeDb();
    await createSmartPlaylist(dst, "favourites", { sort: "rating", minRating: 4, limit: 50, tag: "rock" });
    const r = await importLibrary(dst, runner(dst), parseLibraryExport(JSON.stringify(out)).data!);
    expect(r.playlistsCreated).toBe(1); // only "Mix"
  });

  it("gives a playlist an interrupted import created its rule on the next run", async () => {
    const out = await exportLibrary(await source());
    const data = parseLibraryExport(JSON.stringify(out)).data!;
    const dst = new NodeDb();
    await importLibrary(dst, runner(dst), data);
    const id = (await listPlaylists(dst)).find((p) => p.smart)!.id;
    dst.raw.prepare("DELETE FROM smart_playlists WHERE playlist_id = ?").run(id); // as if the run stopped before the rule
    await importLibrary(dst, runner(dst), data);
    expect(await getSmartRule(dst, id)).toEqual(rule({ minRating: 4, tag: "rock", sort: "rating", limit: 50 }));
  });

  it("never turns an ordinary playlist smart when the source reused its id", async () => {
    // Source: "Mix" (2 tracks) is exported and imported into a library that has the album.
    const src = new NodeDb();
    const a = await upsertTralbum(src, parseTralbumPage(fixture("album"), 0));
    const mix = await createPlaylist(src, "Mix");
    const t = await src.select<{ id: number }>("SELECT id FROM tracks WHERE album_id = ? ORDER BY track_num LIMIT 2", [a]);
    await addTracks(src, mix.id, t.map((x) => x.id));
    const dst = new NodeDb();
    await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    await importLibrary(dst, runner(dst), parseLibraryExport(JSON.stringify(await exportLibrary(src))).data!);
    const mixHere = (await listPlaylists(dst)).find((p) => p.name === "Mix")!;
    expect(mixHere.track_count).toBe(2);

    // Source: "Mix" is deleted and the smart "Faves" reuses its id; export and import again.
    await deletePlaylist(src, mix.id);
    const faves = await createSmartPlaylist(src, "Faves", { minRating: 4 });
    expect(faves.id).toBe(mix.id);
    const out = await exportLibrary(src);
    await importLibrary(dst, runner(dst), parseLibraryExport(JSON.stringify(out)).data!);
    const after = await listPlaylists(dst);
    expect(after.find((p) => p.id === mixHere.id)).toMatchObject({ name: "Mix", smart: false, track_count: 2 });
    expect(after.find((p) => p.name === "Faves")).toMatchObject({ smart: true, rule: rule({ minRating: 4 }) });

    // Even a file keyed the old way ("<library>:<id>") can't give "Mix" a rule.
    const legacy = { ...out, smart_playlists: out.smart_playlists!.map((p) => ({ ...p, name: "Other", key: `${out.library_id}:${faves.id}` })) };
    await importLibrary(dst, runner(dst), parseLibraryExport(JSON.stringify(legacy)).data!);
    expect((await listPlaylists(dst)).find((p) => p.id === mixHere.id)).toMatchObject({ smart: false, track_count: 2 });
  });

  it("files without smart playlists still import, and a bad rule is refused", async () => {
    const out = await exportLibrary(await source());
    const { smart_playlists: _s, ...older } = out;
    expect(parseLibraryExport(JSON.stringify(older)).data).toBeTruthy();
    const bad = { ...out, smart_playlists: [{ ...out.smart_playlists![0], rule: { minRating: 7 } }] };
    expect(parseLibraryExport(JSON.stringify(bad)).error).toMatch(/damaged \(smart_playlists\.0\.rule\.minRating/);
  });

  describe("an older build (v0.5.0)", () => {
    // v0.5.0's whole core source, extracted with git archive into a gitignored folder (outside
    // src, excluded from tsc) so its imports resolve to v0.5.0's own modules.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(here, ".v050");
    let tagged = false;
    try {
      execFileSync("git", ["rev-parse", "-q", "--verify", "v0.5.0^{commit}"], { cwd: here, stdio: "ignore" });
      tagged = true;
    } catch {
      tagged = false; // a checkout without the tag (a shallow clone)
    }
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it.skipIf(!tagged)("parses and imports the file, ignoring smart playlists", async () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const tar = execFileSync("git", ["archive", "v0.5.0", "packages/core/src"], { cwd: path.resolve(here, "../../.."), maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", dir], { input: tar });
      const old = (await import(/* @vite-ignore */ path.join(dir, "packages/core/src/services/libraryTransfer.ts"))) as typeof import("../src/services/libraryTransfer.js");
      const out = await exportLibrary(await source());
      const parsed = old.parseLibraryExport(JSON.stringify(out));
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).not.toHaveProperty("smart_playlists");
      const dst = new NodeDb();
      const r = await old.importLibrary(dst, runner(dst), parsed.data!);
      expect(r.playlistsCreated).toBe(1);
      expect((await listPlaylists(dst)).map((p) => p.name)).toEqual(["Mix"]);
      // "Mix" waits for its album with both entries; no rule reached the library.
      expect(dst.raw.prepare("SELECT COUNT(*) AS n FROM import_pending WHERE kind = 'playlist_track'").get()).toEqual({ n: 2 });
      expect(dst.raw.prepare("SELECT COUNT(*) AS n FROM smart_playlists").get()).toEqual({ n: 0 });
    });
  });
});
