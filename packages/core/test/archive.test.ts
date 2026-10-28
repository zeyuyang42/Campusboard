import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture, waitJob } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { albumIdsByUrl, deleteAlbum, listAlbums, listAlbumTracks, listTags } from "../src/db/repos/albums.js";
import { setArchived, setArchivedMany, isArchived, addPendingArchive, mergePendingArchive } from "../src/db/repos/albumArchive.js";
import { listArtists } from "../src/db/repos/artists.js";
import { searchTracks } from "../src/db/repos/tracks.js";
import { listeningStats } from "../src/db/repos/stats.js";
import { recentlyPlayedAlbums } from "../src/db/repos/plays.js";
import { createSmartPlaylist, getPlaylist } from "../src/db/repos/playlists.js";
import { createCore } from "../src/core.js";
import { exportLibrary, importLibrary, parseLibraryExport, previewLibraryImport, type LibraryExport } from "../src/services/libraryTransfer.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const CUSTOM_ALBUM = "https://music.zoekeating.com/album/snowmelt-ep";

function runnerFor(db: NodeDb) {
  const pages: Record<string, () => string> = { [ALBUM]: () => fixture("album"), [CUSTOM_ALBUM]: () => fixture("custom-album") };
  const fetch = async (url: string) => (pages[url] ? new Response(pages[url](), { status: 200 }) : new Response("not here", { status: 404 }));
  return new JobRunner(db, new FetchQueue(fetch, 0));
}

const ids = (albums: { id: number }[]) => albums.map((a) => a.id).sort((x, y) => x - y);

let db: NodeDb;
let a: number;
let c: number;
beforeEach(async () => {
  db = new NodeDb();
  a = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
  c = await upsertTralbum(db, parseTralbumPage(fixture("custom-album"), 0));
});

describe("archive (#126)", () => {
  it("archives and unarchives, idempotently, and writes nothing for an album that isn't there", async () => {
    expect(await setArchived(db, a, true)).toBe(true);
    expect(await setArchived(db, a, true)).toBe(false);
    expect(await isArchived(db, a)).toBe(true);
    expect((await listAlbums(db, "added", "all", "", "", { archived: "any" })).find((x) => x.id === a)!.archived).toBe(true);
    expect(await setArchived(db, a, false)).toBe(true);
    expect(await isArchived(db, a)).toBe(false);
    expect(await setArchived(db, 9999, true)).toBe(false);
    expect(await db.get("SELECT 1 AS x FROM album_archive")).toBeNull();
  });

  it("the Albums tab leaves an archived album out; Show → Archived lists only it; everything else keeps it", async () => {
    const core = createCore({ db, fetch: async () => new Response("", { status: 404 }) });
    await db.run("INSERT INTO plays (track_id, played_at, seconds_listened) SELECT id, '2026-10-01 10:00:00', 100 FROM tracks WHERE album_id = ? LIMIT 1", [a]);
    await setArchived(db, a, true);
    // The grid, its bulk bar and the Recently played row (the Albums tab).
    expect(ids(await core.albums())).toEqual([c]);
    expect(ids(await core.albums("added", "unplayed"))).toEqual([c]);
    expect((await core.albumTracks()).every((t) => t.album_id === c)).toBe(true);
    expect(ids(await recentlyPlayedAlbums(db))).toEqual([]);
    expect(ids(await core.albums("added", "archived"))).toEqual([a]);
    expect((await core.albumTracks("added", "archived")).every((t) => t.album_id === a)).toBe(true);
    // The palette asks for everything.
    expect(ids(await core.albums("title", "all", "", "", { archived: "any" }))).toEqual([a, c]);
    // Artists, Tracks, Tags, Stats, smart playlists, the album page and by-URL lookups.
    expect((await listArtists(db)).reduce((n, ar) => n + (ar.album_count ?? 0), 0)).toBe(2);
    expect((await searchTracks(db, "")).some((t) => t.album_id === a)).toBe(true);
    const aTags = (await core.album(a))!.tags;
    expect(aTags.length).toBeGreaterThan(0);
    expect((await listTags(db)).map((t) => t.tag.toLowerCase())).toContain(aTags[0].toLowerCase());
    expect((await listeningStats(db, "all", new Date("2026-10-02T00:00:00Z"))).albums.map((x) => x.album_id)).toEqual([a]);
    const smart = await createSmartPlaylist(db, "Everything", { show: "all" });
    expect((await getPlaylist(db, smart.id))!.tracks.some((t) => t.album_id === a)).toBe(true);
    const onlyArchived = await createSmartPlaylist(db, "Shelved", { show: "archived" });
    expect((await getPlaylist(db, onlyArchived.id))!.tracks.every((t) => t.album_id === a)).toBe(true);
    expect(await core.album(a)).not.toBeNull();
    expect((await albumIdsByUrl(db, [ALBUM])).get(ALBUM)).toBe(a);
  });

  it("Unplayed is albums with no counted play", async () => {
    expect(ids(await listAlbums(db, "added", "unplayed"))).toEqual([a, c]);
    await db.run("INSERT INTO plays (track_id, played_at, seconds_listened) SELECT id, '2026-10-01 10:00:00', 100 FROM tracks WHERE album_id = ? LIMIT 1", [c]);
    expect(ids(await listAlbums(db, "added", "unplayed"))).toEqual([a]);
  });

  it("the crate view and the text filter combine with the archive rule", async () => {
    await setArchivedMany(db, [a, c], true);
    // The repo's default is "any" (tags, smart playlists); the Albums tab (core.albums) asks to hide.
    expect(ids(await listAlbums(db))).toEqual([a, c]);
    expect(await listAlbums(db, "added", "all", "", "", { archived: "hide" })).toEqual([]);
    expect(await listAlbumTracks(db, "added", "all", "", "", { archived: "hide" })).toEqual([]);
    expect(ids(await listAlbums(db, "added", "all", "", "", { archived: "only" }))).toEqual([a, c]);
    expect(ids(await listAlbums(db, "added", "archived", "snowmelt"))).toEqual([c]);
    expect(await setArchivedMany(db, [a, c, 9999], false)).toBe(2);
  });

  it("goes with the album: cascade, and vacuumOrphans with foreign keys off", async () => {
    await setArchivedMany(db, [a, c], true);
    await deleteAlbum(db, a);
    expect(await isArchived(db, a)).toBe(false);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    await db.run("DELETE FROM albums WHERE id = ?", [c]);
    expect(await db.get("SELECT 1 AS x FROM album_archive WHERE album_id = ?", [c])).not.toBeNull();
    await vacuumOrphans(db);
    expect(await db.get("SELECT 1 AS x FROM album_archive")).toBeNull();
  });

  it("survives a re-import or refresh of the album", async () => {
    await setArchived(db, a, true);
    expect(await upsertTralbum(db, parseTralbumPage(fixture("album"), 0))).toBe(a);
    expect(await isArchived(db, a)).toBe(true);
  });

  it("is exported by URL and merges as the albums arrive; a file never unarchives, and importing it again restores its marks", async () => {
    await setArchived(db, a, true);
    const file = await exportLibrary(db);
    expect(file.archived).toEqual([{ album_url: ALBUM, archived_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }]);
    const parsed = parseLibraryExport(JSON.stringify(file));
    const data = parsed.data!;
    const dst = new NodeDb();
    const runner = runnerFor(dst);
    expect((await previewLibraryImport(dst, data)).archived).toBe(1);
    const r = await importLibrary(dst, runner, data);
    expect(await dst.get("SELECT 1 AS x FROM album_archive_pending WHERE album_url = ?", [ALBUM])).not.toBeNull();
    expect((await waitJob(dst, r.job!.id)).status).toBe("done");
    const got = (await albumIdsByUrl(dst, [ALBUM, CUSTOM_ALBUM]));
    expect(await isArchived(dst, got.get(ALBUM)!)).toBe(true);
    expect(await isArchived(dst, got.get(CUSTOM_ALBUM)!)).toBe(false);
    expect(await dst.get("SELECT 1 AS x FROM album_archive_pending")).toBeNull();
    // The file only ever marks: the other album stays as it is, and a mark the user undid here
    // comes back with the file (there is no record of the undo to weigh against it).
    await setArchived(dst, got.get(ALBUM)!, false);
    await setArchived(dst, got.get(CUSTOM_ALBUM)!, true);
    await importLibrary(dst, runner, data);
    expect(await isArchived(dst, got.get(ALBUM)!)).toBe(true);
    expect(await isArchived(dst, got.get(CUSTOM_ALBUM)!)).toBe(true);
  });

  it("older files without the field still import, and a damaged mark is refused with a sentence", async () => {
    const file = await exportLibrary(db) as LibraryExport & { archived?: unknown };
    delete file.archived;
    expect(parseLibraryExport(JSON.stringify(file)).data?.archived).toBeUndefined();
    const bad = parseLibraryExport(JSON.stringify({ ...file, archived: [{ album_url: "http://x/", archived_at: "yesterday" }] }));
    expect(bad.error).toMatch(/damaged \(archived/);
  });

  it("pending marks are merged per album too, and skip albums not here", async () => {
    await addPendingArchive(db, [{ album_url: ALBUM, archived_at: "2026-01-01 00:00:00" }, { album_url: "https://x.bandcamp.com/album/none", archived_at: "2026-01-01 00:00:00" }]);
    expect(await mergePendingArchive(db, c)).toBe(0);
    expect(await isArchived(db, a)).toBe(false);
    expect(await mergePendingArchive(db, a)).toBe(1);
    expect(await isArchived(db, a)).toBe(true);
    expect((await db.select("SELECT album_url FROM album_archive_pending")).length).toBe(1);
  });
});
