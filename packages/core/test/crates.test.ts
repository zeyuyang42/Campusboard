import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture, waitJob } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { albumIdsByUrl, deleteAlbum, listAlbums, listAlbumTracks } from "../src/db/repos/albums.js";
import { setArchived } from "../src/db/repos/albumArchive.js";
import {
  addToCrate, createCrate, cratesContaining, cratesOf, deleteCrate, deleteCrateWithUndo, getCrate, listCrates, removeFromCrate, renameCrate, restoreCrate,
  CrateNameError,
} from "../src/db/repos/crates.js";
import { exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport, type LibraryExport } from "../src/services/libraryTransfer.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ALBUM = "https://music.zoekeating.com/album/snowmelt-ep";

function runnerFor(db: NodeDb) {
  const pages: Record<string, () => string> = { [ALBUM]: () => fixture("album"), [CUSTOM_ALBUM]: () => fixture("custom-album") };
  const fetch = async (url: string) => (pages[url] ? new Response(pages[url](), { status: 200 }) : new Response("not here", { status: 404 }));
  return new JobRunner(db, new FetchQueue(fetch, 0));
}

const ids = (albums: { id: number }[]) => albums.map((a) => a.id).sort((x, y) => x - y);
/** Crates by name with their albums' URLs (sorted: a crate has no order of its own, the Library sort applies). */
async function crateShape(db: NodeDb) {
  const out: Record<string, string[]> = {};
  for (const c of await listCrates(db)) {
    out[c.name] = (await db.select<{ url: string }>("SELECT al.url FROM crate_albums ca JOIN albums al ON al.id = ca.album_id WHERE ca.crate_id = ? ORDER BY al.url", [c.id])).map((r) => r.url);
  }
  return out;
}

let db: NodeDb;
let a: number;
let c: number;
beforeEach(async () => {
  db = new NodeDb();
  a = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
  c = await upsertTralbum(db, parseTralbumPage(fixture("custom-album"), 0));
});

describe("crates (#126)", () => {
  it("creates, renames, fills and empties a crate; names are normalised and never empty", async () => {
    const crate = await createCrate(db, "  to   listen ");
    expect(crate).toMatchObject({ name: "to listen", album_count: 0, art_ids: [] });
    await expect(createCrate(db, "   ")).rejects.toBeInstanceOf(CrateNameError);
    expect(await addToCrate(db, crate.id, [a, c, a, 9999])).toBe(2);
    expect(await addToCrate(db, crate.id, [a])).toBe(0);
    expect(await addToCrate(db, 9999, [a])).toBe(0);
    expect((await getCrate(db, crate.id))!).toMatchObject({ album_count: 2 });
    expect((await getCrate(db, crate.id))!.art_ids.length).toBe(2);
    expect((await cratesOf(db, a)).map((x) => x.id)).toEqual([crate.id]);
    expect(await renameCrate(db, crate.id, "Later")).toBe(true);
    await expect(renameCrate(db, crate.id, "")).rejects.toBeInstanceOf(CrateNameError);
    expect((await listCrates(db)).map((x) => x.name)).toEqual(["Later"]);
    expect(await removeFromCrate(db, crate.id, [a])).toBe(1);
    expect(await removeFromCrate(db, crate.id, [a])).toBe(0);
    expect(await cratesOf(db, a)).toEqual([]);
  });

  it("takes a name of 100 user-perceived characters that is more code points than that", async () => {
    // "e" + combining acute: two code points per character; SQLite's length() counts code points.
    const long = "é".repeat(100);
    const crate = await createCrate(db, long);
    expect(crate.name).toBe(long);
    expect(await renameCrate(db, crate.id, `${long} and more`)).toBe(true);
    expect((await getCrate(db, crate.id))!.name).toBe(long);
    expect((await listCrates(db)).map((x) => x.name)).toEqual([long]);
  });

  it("lists by name, and the picker's counts say all, some or none", async () => {
    const z = await createCrate(db, "zzz");
    const m = await createCrate(db, "Mmm");
    const n = await createCrate(db, "none");
    await addToCrate(db, z.id, [a, c]);
    await addToCrate(db, m.id, [a]);
    expect((await listCrates(db)).map((x) => x.name)).toEqual(["Mmm", "none", "zzz"]);
    const marks = await cratesContaining(db, [a, c]);
    expect(marks.get(z.id)).toBe(2);
    expect(marks.get(m.id)).toBe(1);
    expect(marks.has(n.id)).toBe(false);
    expect((await cratesContaining(db, [])).size).toBe(0);
  });

  it("the crate view is the Albums grid narrowed to the crate, with Show, text and the archive rule", async () => {
    const crate = await createCrate(db, "Crate");
    await addToCrate(db, crate.id, [a]);
    expect(ids(await listAlbums(db, "added", "all", "", "", { crate: crate.id }))).toEqual([a]);
    expect(ids(await listAlbums(db, "added", "all", "snowmelt", "", { crate: crate.id }))).toEqual([]);
    expect((await listAlbumTracks(db, "added", "all", "", "", { crate: crate.id })).every((t) => t.album_id === a)).toBe(true);
    expect(ids(await listAlbums(db, "added", "unplayed", "", "", { crate: crate.id }))).toEqual([a]);
    // With a tag (#71): the album's own tag keeps it, another album's tag leaves the crate view empty.
    const aTag = (await listAlbums(db)).find((x) => x.id === a)!.tags[0];
    const cTag = (await listAlbums(db)).find((x) => x.id === c)!.tags.find((t) => t.toLowerCase() !== aTag.toLowerCase())!;
    expect(aTag && cTag).toBeTruthy();
    expect(ids(await listAlbums(db, "added", "all", "", aTag, { crate: crate.id }))).toEqual([a]);
    expect(ids(await listAlbums(db, "added", "all", "", cTag, { crate: crate.id }))).toEqual([]);
    expect(ids(await listAlbums(db, "added", "all", "", cTag))).toContain(c);
    await setArchived(db, a, true);
    expect(ids(await listAlbums(db, "added", "all", "", "", { crate: crate.id, archived: "hide" }))).toEqual([]);
    expect(ids(await listAlbums(db, "added", "archived", "", "", { crate: crate.id }))).toEqual([a]);
    // An unknown crate matches nothing rather than everything.
    expect(await listAlbums(db, "added", "all", "", "", { crate: 9999 })).toEqual([]);
  });

  it("delete with Undo brings the crate back with its memberships, under its old id when free", async () => {
    const crate = await createCrate(db, "Keep");
    await addToCrate(db, crate.id, [a, c]);
    const snap = (await deleteCrateWithUndo(db, crate.id))!;
    expect(snap.albums.map((x) => x.album_id).sort()).toEqual([a, c].sort());
    expect(await listCrates(db)).toEqual([]);
    expect(await deleteCrateWithUndo(db, crate.id)).toBeNull();
    expect(await restoreCrate(db, snap)).toBe(crate.id);
    expect((await getCrate(db, crate.id))!).toMatchObject({ name: "Keep", album_count: 2, created_at: crate.created_at });
    // Restored twice: nothing doubles.
    expect(await restoreCrate(db, snap)).toBe(crate.id);
    expect(await listCrates(db)).toHaveLength(1);
    // The old id taken meanwhile: a new one, same contents (minus albums gone since).
    const snap2 = (await deleteCrateWithUndo(db, crate.id))!;
    const other = await createCrate(db, "Other");
    expect(other.id).toBe(crate.id);
    await deleteAlbum(db, c);
    const back = await restoreCrate(db, snap2);
    expect(back).not.toBe(crate.id);
    expect((await getCrate(db, back))!).toMatchObject({ name: "Keep", album_count: 1 });
  });

  it("memberships go with the album and with the crate: cascade, and vacuumOrphans with foreign keys off", async () => {
    const crate = await createCrate(db, "Crate");
    await addToCrate(db, crate.id, [a, c]);
    await deleteAlbum(db, a);
    expect((await getCrate(db, crate.id))!.album_count).toBe(1);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    await db.run("DELETE FROM albums WHERE id = ?", [c]);
    await db.run("DELETE FROM crates WHERE id = ?", [crate.id]);
    expect(await db.get("SELECT 1 AS x FROM crate_albums")).not.toBeNull();
    await vacuumOrphans(db);
    expect(await db.get("SELECT 1 AS x FROM crate_albums")).toBeNull();
    expect(await deleteCrate(db, crate.id)).toBe(false);
  });

  it("survives a re-import or refresh of the album", async () => {
    const crate = await createCrate(db, "Crate");
    await addToCrate(db, crate.id, [a]);
    expect(await upsertTralbum(db, parseTralbumPage(fixture("album"), 0))).toBe(a);
    expect((await cratesOf(db, a)).map((x) => x.id)).toEqual([crate.id]);
  });

  describe("library file", () => {
    let data: LibraryExport;
    beforeEach(async () => {
      const first = await createCrate(db, "To listen");
      await addToCrate(db, first.id, [c]);
      await db.run("UPDATE crate_albums SET added_at = '2026-01-01 00:00:00' WHERE album_id = ?", [c]);
      await addToCrate(db, first.id, [a]);
      await createCrate(db, "Empty");
      const parsed = parseLibraryExport(JSON.stringify(await exportLibrary(db)));
      if (!parsed.data) throw new Error(parsed.error);
      data = parsed.data;
    });

    it("exports crates by key with their albums' URLs in added order", () => {
      expect(data.crates!.map((x) => ({ name: x.name, albums: x.albums }))).toEqual([{ name: "To listen", albums: [CUSTOM_ALBUM, ALBUM] }, { name: "Empty", albums: [] }]);
      expect(data.crates![0].key).toMatch(/:crate:\d+$/);
    });

    it("round-trips into an empty library, filling crates as their albums arrive, and is idempotent", async () => {
      const dst = new NodeDb();
      const runner = runnerFor(dst);
      expect((await previewLibraryImport(dst, data)).crates).toEqual({ total: 2, new: 2 });
      const r = await importLibrary(dst, runner, data);
      expect((await listCrates(dst)).map((x) => [x.name, x.album_count])).toEqual([["Empty", 0], ["To listen", 0]]);
      expect((await dst.select("SELECT 1 AS x FROM crate_albums_pending")).length).toBe(2);
      expect((await waitJob(dst, r.job!.id)).status).toBe("done");
      expect(await crateShape(dst)).toEqual(await crateShape(db));
      expect(await dst.get("SELECT 1 AS x FROM crate_albums_pending")).toBeNull();
      // Again: found by key, nothing created, nothing doubled.
      expect((await previewLibraryImport(dst, data)).crates).toEqual({ total: 2, new: 0 });
      await importLibrary(dst, runner, data);
      expect(await crateShape(dst)).toEqual(await crateShape(db));
      expect(await listCrates(dst)).toHaveLength(2);
    });

    it("merges into a crate of the same name here rather than making a second one", async () => {
      const dst = new NodeDb();
      const runner = runnerFor(dst);
      const mine = await createCrate(dst, "to listen");
      await waitJob(dst, (await importLibrary(dst, runner, data)).job!.id);
      expect((await listCrates(dst)).map((x) => [x.id, x.name, x.album_count])).toEqual([[2, "Empty", 0], [mine.id, "to listen", 2]]);
    });

    it("importing into the library that made the file changes nothing", async () => {
      const before = await crateShape(db);
      expect((await previewLibraryImport(db, data)).crates).toEqual({ total: 2, new: 0 });
      await importLibrary(db, runnerFor(db), data);
      expect(await crateShape(db)).toEqual(before);
      expect(await listCrates(db)).toHaveLength(2);
    });

    it("a deleted imported crate comes back by Undo with its link, and a membership URL is validated", async () => {
      const dst = new NodeDb();
      const runner = runnerFor(dst);
      await waitJob(dst, (await importLibrary(dst, runner, data)).job!.id);
      const crate = (await listCrates(dst)).find((x) => x.name === "To listen")!;
      const snap = (await deleteCrateWithUndo(dst, crate.id))!;
      expect(snap.imported).toHaveLength(1);
      await restoreCrate(dst, snap);
      expect((await previewLibraryImport(dst, data)).crates).toEqual({ total: 2, new: 0 });
      const hostile = { ...data, crates: [{ key: "x:crate:1", name: "Bad", created_at: "2026-01-01T00:00:00Z", albums: ["https://192.168.1.1/album/x", ALBUM] }] };
      await importLibrary(dst, runner, hostile as LibraryExport);
      const bad = (await listCrates(dst)).find((x) => x.name === "Bad")!;
      expect(bad.album_count).toBe(1);
      expect((await albumIdsByUrl(dst, [ALBUM])).size).toBe(1);
    });

    it("imports a crate whose name is 100 user-perceived characters, and still queues the albums", async () => {
      const long = "é".repeat(100);
      const dst = new NodeDb();
      const runner = runnerFor(dst);
      const file = { ...data, crates: [{ key: "x:crate:7", name: long, created_at: "2026-01-01T00:00:00Z", albums: [ALBUM] }] } as LibraryExport;
      const r = await importLibrary(dst, runner, file);
      expect(r.queued).toBe(2);
      expect((await listCrates(dst)).map((x) => x.name)).toEqual([long]);
      expect((await waitJob(dst, r.job!.id)).status).toBe("done");
      expect((await listCrates(dst))[0].album_count).toBe(1);
    });

    it("older files without the field still import, and a damaged crate is refused with a sentence", () => {
      const file = { ...data } as LibraryExport & { crates?: unknown };
      delete file.crates;
      expect(parseLibraryExport(JSON.stringify(file)).data?.crates).toBeUndefined();
      expect(parseLibraryExport(JSON.stringify({ ...data, crates: [{ key: "k", name: "x", created_at: "t", albums: ["not a url"] }] })).error).toMatch(/damaged \(crates/);
    });
  });
});
