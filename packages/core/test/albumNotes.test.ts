import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture, waitJob } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { deleteAlbum, getAlbum, listAlbums, listAlbumTracks } from "../src/db/repos/albums.js";
import { getAlbumNote, setAlbumNote, setAlbumRating, NOTE_MAX } from "../src/db/repos/albumNotes.js";
import { clearPending, countPending } from "../src/db/repos/importPending.js";
import { setSetting } from "../src/db/repos/settings.js";
import { exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport, LibraryExportSchema } from "../src/services/libraryTransfer.js";
import * as jobs from "../src/db/repos/jobs.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ALBUM = "https://music.zoekeating.com/album/snowmelt-ep";

function runnerFor(db: NodeDb) {
  const pages: Record<string, () => string> = { [ALBUM]: () => fixture("album"), [CUSTOM_ALBUM]: () => fixture("custom-album") };
  const fetch = async (url: string) => (pages[url] ? new Response(pages[url](), { status: 200 }) : new Response("not here", { status: 404 }));
  return new JobRunner(db, new FetchQueue(fetch, 0));
}
const setUpdated = (db: NodeDb, id: number, at: string) => db.run("UPDATE album_notes SET updated_at = ? WHERE album_id = ?", [at, id]);

let db: NodeDb;
let a: number;
let c: number;
beforeEach(async () => {
  db = new NodeDb();
  a = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
  c = await upsertTralbum(db, parseTralbumPage(fixture("custom-album"), 0));
});

describe("album notes and ratings (#73)", () => {
  it("saves rating and note independently, clamped, and clears them", async () => {
    expect(await getAlbumNote(db, a)).toBeNull();
    await setAlbumRating(db, a, 4);
    await setAlbumNote(db, a, "Side B, track 3.");
    expect(await getAlbumNote(db, a)).toMatchObject({ rating: 4, note: "Side B, track 3." });
    await setAlbumRating(db, a, 9);
    expect((await getAlbumNote(db, a))!.rating).toBe(5);
    await setAlbumRating(db, a, -2);
    expect((await getAlbumNote(db, a))!.rating).toBe(0);
    // Characters, not UTF-16 units: an emoji counts once, like SQLite's length().
    await setAlbumNote(db, a, "🎧".repeat(NOTE_MAX + 5));
    expect(Array.from((await getAlbumNote(db, a))!.note)).toHaveLength(NOTE_MAX);
    await setAlbumNote(db, a, "");
    expect(await getAlbumNote(db, a)).toMatchObject({ rating: 0, note: "" });
  });

  it("writes nothing for an album that isn't there", async () => {
    await setAlbumRating(db, 9999, 3);
    expect(await db.get("SELECT 1 AS x FROM album_notes")).toBeNull();
  });

  it("survives a re-import or refresh of the album", async () => {
    await setAlbumRating(db, a, 3);
    await setAlbumNote(db, a, "keep me");
    expect(await upsertTralbum(db, parseTralbumPage(fixture("album"), 0))).toBe(a);
    expect(await getAlbumNote(db, a)).toMatchObject({ rating: 3, note: "keep me" });
  });

  it("goes with the album: cascade, and vacuumOrphans with foreign keys off", async () => {
    await setAlbumRating(db, a, 3);
    await setAlbumRating(db, c, 2);
    await deleteAlbum(db, a);
    expect(await getAlbumNote(db, a)).toBeNull();
    db.raw.exec("PRAGMA foreign_keys = OFF");
    await db.run("DELETE FROM albums WHERE id = ?", [c]);
    expect(await db.get("SELECT 1 AS x FROM album_notes WHERE album_id = ?", [c])).not.toBeNull();
    await vacuumOrphans(db);
    expect(await db.get("SELECT 1 AS x FROM album_notes")).toBeNull();
  });

  it("the Rating sort puts the highest first and the unrated last; Rated shows only rated albums", async () => {
    // c was added last, so it leads "added": the rating has to move a ahead of it.
    expect((await listAlbums(db, "rating")).map((x) => [x.id, x.rating])).toEqual([[c, 0], [a, 0]]);
    await setAlbumRating(db, a, 2);
    expect((await listAlbums(db, "rating")).map((x) => [x.id, x.rating])).toEqual([[a, 2], [c, 0]]);
    await setAlbumRating(db, c, 5);
    expect((await listAlbums(db, "rating")).map((x) => [x.id, x.rating])).toEqual([[c, 5], [a, 2]]);
    expect((await listAlbums(db, "added", "rated")).map((x) => x.id).sort()).toEqual([a, c].sort());
    await setAlbumRating(db, a, 0); // a cleared rating is unrated again
    expect((await listAlbums(db, "added", "rated")).map((x) => x.id)).toEqual([c]);
    expect((await getAlbum(db, c))!.rating).toBe(5);
    // Bulk actions follow the same order and filter.
    const ts = await listAlbumTracks(db, "rating", "rated");
    expect(new Set(ts.map((t) => t.album_id))).toEqual(new Set([c]));
  });
});

describe("library export and import of notes (#27, #73)", () => {
  it("round-trips by album URL into an empty library, as the albums arrive", async () => {
    await setAlbumRating(db, a, 4);
    await setAlbumNote(db, a, "Great at night.");
    await setAlbumNote(db, c, "Cello.");
    const parsed = parseLibraryExport(JSON.stringify(await exportLibrary(db)));
    expect(parsed.data?.notes).toHaveLength(2);
    expect(parsed.data?.notes).toContainEqual(expect.objectContaining({ album_url: ALBUM, rating: 4, note: "Great at night." }));

    const dst = new NodeDb();
    expect((await previewLibraryImport(dst, parsed.data!)).notes).toBe(2);
    const r = await importLibrary(dst, runnerFor(dst), parsed.data!);
    expect((await countPending(dst)).notes).toBe(2);
    await waitJob(dst, r.job!.id);
    const id = async (url: string) => (await dst.get<{ id: number }>("SELECT id FROM albums WHERE url = ?", [url]))!.id;
    expect(await getAlbumNote(dst, await id(ALBUM))).toMatchObject({ rating: 4, note: "Great at night." });
    expect(await getAlbumNote(dst, await id(CUSTOM_ALBUM))).toMatchObject({ rating: 0, note: "Cello." });
    expect((await countPending(dst)).notes).toBe(0);
  });

  it("merges into a library that has the albums: a newer local edit wins, an older one is replaced", async () => {
    await setAlbumNote(db, a, "from the file");
    await setAlbumNote(db, c, "from the file");
    await setUpdated(db, a, "2026-10-01 10:00:00");
    await setUpdated(db, c, "2026-10-01 10:00:00");
    const data = parseLibraryExport(JSON.stringify(await exportLibrary(db))).data!;

    const dst = new NodeDb();
    const da = await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    const dc = await upsertTralbum(dst, parseTralbumPage(fixture("custom-album"), 0));
    await setAlbumNote(dst, da, "newer here");
    await setUpdated(dst, da, "2026-10-05 10:00:00");
    await setAlbumNote(dst, dc, "older here");
    await setUpdated(dst, dc, "2026-09-01 10:00:00");
    const r = await importLibrary(dst, runnerFor(dst), data);
    expect(r.job).toBeNull();
    expect((await getAlbumNote(dst, da))!.note).toBe("newer here");
    expect((await getAlbumNote(dst, dc))).toMatchObject({ note: "from the file", updated_at: "2026-10-01 10:00:00" });
    // Importing again changes nothing and leaves nothing waiting.
    await importLibrary(dst, runnerFor(dst), data);
    expect((await getAlbumNote(dst, da))!.note).toBe("newer here");
    expect((await countPending(dst)).notes).toBe(0);
  });

  it("caps a file's future updated_at at the export time, so it can't beat later local edits", async () => {
    await setAlbumNote(db, a, "from the file");
    const data = parseLibraryExport(JSON.stringify(await exportLibrary(db))).data!;
    data.exported_at = "2026-10-01T10:00:00.000Z";
    data.notes![0].updated_at = "2099-01-01 00:00:00"; // a clock far ahead
    const dst = new NodeDb();
    const da = await upsertTralbum(dst, parseTralbumPage(fixture("album"), 0));
    await setAlbumNote(dst, da, "edited here later");
    await setUpdated(dst, da, "2026-10-02 10:00:00");
    await importLibrary(dst, runnerFor(dst), { ...data, albums: data.albums.filter((x) => x.url === ALBUM) });
    expect((await getAlbumNote(dst, da))!.note).toBe("edited here later");
    // Older than the export: the file's edit is the newer one and is taken, with its time capped.
    await setUpdated(dst, da, "2026-09-01 10:00:00");
    await importLibrary(dst, runnerFor(dst), { ...data, albums: data.albums.filter((x) => x.url === ALBUM) });
    expect(await getAlbumNote(dst, da)).toMatchObject({ note: "from the file", updated_at: "2026-10-01 10:00:00" });
  });

  it("Stop waiting forgets notes whose albums never came", async () => {
    await setAlbumNote(db, a, "x");
    const data = parseLibraryExport(JSON.stringify(await exportLibrary(db))).data!;
    const dst = new NodeDb();
    const lone = { ...data, albums: [] }; // the album isn't queued, so its note waits
    await importLibrary(dst, runnerFor(dst), lone);
    expect((await countPending(dst)).notes).toBe(1);
    await clearPending(dst);
    expect((await countPending(dst)).notes).toBe(0);
  });

  it("stays readable for older builds: notes are an optional extra field and a Rating sort isn't exported", async () => {
    await setSetting(db, "library_view", { sort: "rating", filter: "all" });
    await setAlbumRating(db, a, 5);
    const out = JSON.parse(JSON.stringify(await exportLibrary(db)));
    expect(out.version).toBe(1);
    expect(out.settings.library_view).toBeNull();
    // An older build's schema is this one without `notes`: it parses the file and drops them.
    const older = LibraryExportSchema.omit({ notes: true }).safeParse(out);
    expect(older.success).toBe(true);
    expect(older.data).not.toHaveProperty("notes");
    // A file from before notes existed still imports.
    delete out.notes;
    expect(parseLibraryExport(JSON.stringify(out)).data).toBeTruthy();
  });

  it("rejects a damaged note", async () => {
    await setAlbumRating(db, a, 5);
    const out = JSON.parse(JSON.stringify(await exportLibrary(db)));
    out.notes[0].rating = 7;
    expect(parseLibraryExport(JSON.stringify(out)).error).toMatch(/notes\.0\.rating/);
  });
});
