import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { createCore } from "../src/core.js";
import {
  addTracks, createPlaylist, createSmartPlaylist, deletePlaylistWithUndo, getPlaylist, listPlaylists, removeTracksWithUndo, reorder,
  restorePlaylist, restoreTracks,
} from "../src/db/repos/playlists.js";
import { getSmartRule, parseSmartRule } from "../src/db/repos/smartPlaylists.js";
import { listAlbums, listAlbumTracks, listTags } from "../src/db/repos/albums.js";
import { searchTracks } from "../src/db/repos/tracks.js";
import { getArtist, listArtists } from "../src/db/repos/artists.js";
import { markRemoving, removingAlbumIds, REMOVING_KEY, unmarkRemoving } from "../src/db/repos/albumRemoval.js";
import { getAlbumNote } from "../src/db/repos/albumNotes.js";
import { exportLibrary, importLibrary, parseLibraryExport } from "../src/services/libraryTransfer.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import type { OfflineFiles } from "../src/services/offline.js";

let db: NodeDb;
let nextId = 1;

function artist(name: string): number {
  const id = nextId++;
  db.raw.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (?, ?, ?, ?)").run(id, id, name, `https://a${id}.bandcamp.com`);
  return id;
}

/** An album with `n` tracks; returns its id and its tracks' ids. */
function album(artistId: number, title: string, n = 3, tags: string[] = ["ambient"]): { id: number; artist: number; tracks: number[] } {
  const id = nextId++;
  db.raw.prepare(
    `INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, tags_json, fetched_at)
     VALUES (?, ?, 'album', ?, ?, ?, ?, '2026-01-01 00:00:00')`,
  ).run(id, id, artistId, title, `https://x.bandcamp.com/album/${id}`, JSON.stringify(tags));
  const tracks: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, track_num, streamable) VALUES (?, ?, ?, ?, 1)").run(id * 100 + i, id, `${title} ${i + 1}`, i + 1);
    tracks.push(Number(r.lastInsertRowid));
  }
  return { id, artist: artistId, tracks };
}

const order = async (pid: number) => (await getPlaylist(db, pid))!.tracks.map((t) => t.id);
const positions = (pid: number) => db.raw.prepare("SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(pid).map((r) => (r as { position: number }).position);

let a: ReturnType<typeof album>;
let b: ReturnType<typeof album>;

beforeEach(() => {
  db = new NodeDb();
  nextId = 1;
  const ar = artist("Aphex");
  a = album(ar, "Alpha", 5);
  b = album(artist("Boards"), "Beta", 3, ["idm"]);
});

describe("removing playlist tracks with Undo (#93)", () => {
  it("puts one entry back at its place, under its old id", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, a.tracks);
    const before = await getPlaylist(db, pl.id);
    const victim = before!.tracks[2];
    const snap = await removeTracksWithUndo(db, pl.id, [victim.playlist_track_id]);
    expect(snap!.rows).toEqual([expect.objectContaining({ id: victim.playlist_track_id, track_id: victim.id, k: 2 })]);
    expect(await order(pl.id)).toEqual([a.tracks[0], a.tracks[1], a.tracks[3], a.tracks[4]]);

    expect(await restoreTracks(db, snap!)).toBe(1);
    const after = await getPlaylist(db, pl.id);
    expect(after!.tracks.map((t) => t.id)).toEqual(a.tracks);
    expect(after!.tracks[2].playlist_track_id).toBe(victim.playlist_track_id);
    expect(positions(pl.id)).toEqual([0, 1, 2, 3, 4]);
    // A second Undo of the same snapshot adds nothing and keeps the order.
    expect(await restoreTracks(db, snap!)).toBe(0);
    expect(await order(pl.id)).toEqual(a.tracks);
  });

  it("restores several entries, the first and last too, after the playlist changed meanwhile", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, a.tracks);
    const t = (await getPlaylist(db, pl.id))!.tracks;
    const snap = await removeTracksWithUndo(db, pl.id, [t[0].playlist_track_id, t[2].playlist_track_id, t[4].playlist_track_id]);
    expect(snap!.rows.map((r) => r.k)).toEqual([0, 2, 4]);
    // Meanwhile: a track appended (positions now have gaps and a new max).
    await addTracks(db, pl.id, [b.tracks[0]]);
    await restoreTracks(db, snap!);
    expect(await order(pl.id)).toEqual([...a.tracks, b.tracks[0]]);
    expect(positions(pl.id)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("works on a reordered playlist and with a duplicate track", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, [a.tracks[0], a.tracks[1], a.tracks[0], a.tracks[2]]);
    const t = (await getPlaylist(db, pl.id))!.tracks;
    await reorder(db, pl.id, [t[3], t[2], t[1], t[0]].map((x) => x.playlist_track_id));
    const shown = (await getPlaylist(db, pl.id))!.tracks;
    const snap = await removeTracksWithUndo(db, pl.id, [shown[1].playlist_track_id]);
    expect(await order(pl.id)).toEqual([a.tracks[2], a.tracks[1], a.tracks[0]]);
    await restoreTracks(db, snap!);
    expect((await getPlaylist(db, pl.id))!.tracks.map((x) => x.playlist_track_id)).toEqual(shown.map((x) => x.playlist_track_id));
  });

  it("takes a new id when the old one was reused, and skips a track that is gone", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, [a.tracks[0], b.tracks[0]]);
    const t = (await getPlaylist(db, pl.id))!.tracks;
    const snap = await removeTracksWithUndo(db, pl.id, [t[1].playlist_track_id]);
    // SQLite hands the freed highest id to the next insert.
    await addTracks(db, pl.id, [a.tracks[1]]);
    expect((await getPlaylist(db, pl.id))!.tracks[1].playlist_track_id).toBe(t[1].playlist_track_id);
    await restoreTracks(db, snap!);
    const after = (await getPlaylist(db, pl.id))!.tracks;
    expect(after.map((x) => x.id)).toEqual([a.tracks[0], b.tracks[0], a.tracks[1]]);
    expect(after[1].playlist_track_id).not.toBe(t[1].playlist_track_id);

    const snap2 = await removeTracksWithUndo(db, pl.id, [after[1].playlist_track_id]);
    db.raw.prepare("DELETE FROM albums WHERE id = ?").run(b.id);
    expect(await restoreTracks(db, snap2!)).toBe(0);
    expect(await order(pl.id)).toEqual([a.tracks[0], a.tracks[1]]);
  });

  it("returns null when nothing was removed", async () => {
    const pl = await createPlaylist(db, "Mix");
    expect(await removeTracksWithUndo(db, pl.id, [999])).toBeNull();
    expect(await removeTracksWithUndo(db, pl.id, [])).toBeNull();
  });
});

describe("deleting a playlist with Undo (#93)", () => {
  it("brings back an ordinary playlist under its id, with its entries, dates and export key", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, [b.tracks[1], a.tracks[0], b.tracks[0]]);
    db.raw.prepare("UPDATE playlists SET created_at = '2025-05-05 05:05:05', updated_at = '2025-06-06 06:06:06' WHERE id = ?").run(pl.id);
    const keyBefore = (await exportLibrary(db)).playlists[0].key;
    const before = await getPlaylist(db, pl.id);

    const snap = await deletePlaylistWithUndo(db, pl.id);
    expect(await listPlaylists(db)).toEqual([]);
    expect(await restorePlaylist(db, snap!)).toBe(pl.id);
    const after = await getPlaylist(db, pl.id);
    expect(after).toEqual(before);
    expect((await exportLibrary(db)).playlists[0].key).toBe(keyBefore);
    // Again: nothing doubles.
    expect(await restorePlaylist(db, snap!)).toBe(pl.id);
    expect((await listPlaylists(db)).length).toBe(1);
    expect((await getPlaylist(db, pl.id))!.tracks.length).toBe(3);
  });

  it("brings back a smart playlist with its rule", async () => {
    const rule = parseSmartRule({ tag: "idm", sort: "title" })!;
    const pl = await createSmartPlaylist(db, "IDM", rule);
    const snap = await deletePlaylistWithUndo(db, pl.id);
    expect(snap!.rule_json).not.toBeNull();
    expect(await getSmartRule(db, pl.id)).toBeNull();
    const id = await restorePlaylist(db, snap!);
    expect(id).toBe(pl.id);
    expect(await getSmartRule(db, id)).toEqual(rule);
    expect((await getPlaylist(db, id))!.tracks.map((t) => t.id)).toEqual(b.tracks);
  });

  it("takes a new id when the old one is taken, and the library file still imports into it once", async () => {
    const pl = await createPlaylist(db, "Mix");
    await addTracks(db, pl.id, [a.tracks[0]]);
    const snap = await deletePlaylistWithUndo(db, pl.id);
    const other = await createPlaylist(db, "Other");
    expect(other.id).toBe(pl.id);
    const id = await restorePlaylist(db, snap!);
    expect(id).not.toBe(pl.id);
    expect((await getPlaylist(db, id))!.name).toBe("Mix");
    expect(await order(id)).toEqual([a.tracks[0]]);
    // Its own library file, read back: both playlists are recognised as present.
    const file = parseLibraryExport(JSON.stringify(await exportLibrary(db)));
    if ("error" in file) throw new Error(file.error);
    const queue = new FetchQueue(async () => new Response(""), 0);
    await importLibrary(db, new JobRunner(db, queue, () => {}), file.data);
    expect((await listPlaylists(db)).length).toBe(2);
  });

  it("keeps the link to the library file it came from, and what it still waits for", async () => {
    const src = new NodeDb();
    const sa = src.raw;
    sa.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (1, 1, 'A', 'https://a1.bandcamp.com')").run();
    sa.prepare("INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (1, 1, 'album', 1, 'Alpha', ?, '2026-01-01')").run(`https://x.bandcamp.com/album/${a.id}`);
    sa.prepare("INSERT INTO tracks (id, track_id, album_id, title, track_num, streamable) VALUES (1, ?, 1, 'Alpha 1', 1, 1)").run(a.id * 100);
    sa.prepare("INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (2, 77, 'album', 1, 'Elsewhere', 'https://y.bandcamp.com/album/z', '2026-01-01')").run();
    sa.prepare("INSERT INTO tracks (id, track_id, album_id, title, track_num, streamable) VALUES (2, 7700, 2, 'Far', 1, 1)").run();
    const spl = await createPlaylist(src, "From afar");
    await addTracks(src, spl.id, [1, 2]);
    const file = parseLibraryExport(JSON.stringify(await exportLibrary(src)));
    if ("error" in file) throw new Error(file.error);
    const queue = new FetchQueue(async () => new Response("", { status: 404 }), 0);
    const runner = new JobRunner(db, queue, () => {});
    await importLibrary(db, runner, file.data);
    const pl = (await listPlaylists(db)).find((p) => p.name === "From afar")!;
    const waiting = () => db.raw.prepare("SELECT COUNT(*) AS n FROM import_pending WHERE playlist_id IS NOT NULL").get() as { n: number };
    const mapped = () => db.raw.prepare("SELECT playlist_id FROM imported_playlists").all();
    expect(waiting().n).toBe(1);
    expect(mapped()).toEqual([{ playlist_id: pl.id }]);

    const snap = await deletePlaylistWithUndo(db, pl.id);
    expect(waiting().n).toBe(0);
    expect(mapped()).toEqual([]);
    await restorePlaylist(db, snap!);
    expect(waiting().n).toBe(1);
    expect(mapped()).toEqual([{ playlist_id: pl.id }]);
    await importLibrary(db, runner, file.data);
    expect((await listPlaylists(db)).filter((p) => p.name.startsWith("From afar")).length).toBe(1);
  });
});

class MemFiles implements OfflineFiles {
  files = new Map<string, Uint8Array>();
  async write() {}
  async rename() {}
  async remove(name: string) { this.files.delete(name); }
  async exists(name: string) { return this.files.has(name); }
  async list() { return [...this.files.keys()]; }
  url(name: string) { return `mem:${name}`; }
}

describe("removing an album with Undo (#93)", () => {
  it("hides a marked album from the Library, tags, search, artists and smart playlists", async () => {
    expect(await markRemoving(db, b.id)).toBe(true);
    expect((await listAlbums(db)).map((x) => x.id)).toEqual([a.id]);
    expect((await listTags(db)).map((t) => t.tag)).toEqual(["ambient"]);
    expect((await searchTracks(db, "Beta")).length).toBe(0);
    expect((await searchTracks(db, "")).every((t) => t.album_id === a.id)).toBe(true);
    expect((await listArtists(db)).map((x) => x.name)).toEqual(["Aphex"]);
    expect((await getArtist(db, b.artist))!.albums).toEqual([]);
    expect((await listAlbumTracks(db)).every((t) => t.album_id === a.id)).toBe(true);
    const smart = await createSmartPlaylist(db, "IDM", { tag: "idm" });
    expect((await getPlaylist(db, smart.id))!.tracks).toEqual([]);

    await unmarkRemoving(db, [b.id]);
    expect((await listAlbums(db)).length).toBe(2);
    expect((await getPlaylist(db, smart.id))!.tracks.length).toBe(3);
  });

  it("marks only albums that exist, keeps other marks, and a damaged value hides nothing", async () => {
    expect(await markRemoving(db, 999)).toBe(false);
    await markRemoving(db, a.id);
    expect(await markRemoving(db, b.id)).toBe(true);
    expect(await markRemoving(db, b.id)).toBe(false);
    expect(await removingAlbumIds(db)).toEqual([a.id, b.id]);
    expect(JSON.parse((db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(REMOVING_KEY) as { value: string }).value)).toEqual([a.id, b.id]);
    await unmarkRemoving(db, [b.id]);
    expect(await removingAlbumIds(db)).toEqual([a.id]);
    db.raw.prepare("UPDATE settings SET value = 'oops' WHERE key = ?").run(REMOVING_KEY);
    expect((await listAlbums(db)).length).toBe(2);
    expect(await removingAlbumIds(db)).toEqual([]);
    expect(await markRemoving(db, b.id)).toBe(true);
    expect(await removingAlbumIds(db)).toEqual([b.id]);
  });

  it("an Undo keeps everything; finishing deletes rows, notes, plays, resume points and offline files", async () => {
    const files = new MemFiles();
    const core = createCore({ db, fetch: async () => new Response(""), files });
    await core.finishAlbumRemovals(); // the start-up pass
    const t = b.tracks[0];
    db.raw.prepare("UPDATE tracks SET local_path = ? WHERE id = ?").run(`${b.id * 100}.mp3`, t);
    files.files.set(`${b.id * 100}.mp3`, new Uint8Array(3));
    await core.setAlbumRating(b.id, 4);
    await core.setAlbumNote(b.id, "late night");
    await core.recordPlay(t, 120);
    await core.saveResumePosition(t, 300);
    const pl = await core.createPlaylist("Mix");
    await core.addToPlaylist(pl.id, [t, a.tracks[0]]);

    expect(await core.removeAlbumLater(b.id)).toBe(true);
    expect((await core.albums()).map((x) => x.id)).toEqual([a.id]);
    await core.undoRemoveAlbum(b.id);
    // A finish that comes after the Undo deletes nothing.
    expect(await core.finishAlbumRemovals([b.id])).toBe(0);
    expect((await core.albums()).length).toBe(2);
    expect((await getAlbumNote(db, b.id))!.note).toBe("late night");
    expect(await core.playCount()).toBe(1);
    expect(await core.resumePosition(t)).toBe(300);
    expect(files.files.size).toBe(1);

    await core.removeAlbumLater(b.id);
    expect(await core.finishAlbumRemovals([b.id])).toBe(1);
    expect(await core.album(b.id)).toBeNull();
    expect(await getAlbumNote(db, b.id)).toBeNull();
    expect(await core.playCount()).toBe(0);
    expect(await core.resumePosition(t)).toBeNull();
    expect(files.files.size).toBe(0);
    expect(await order(pl.id)).toEqual([a.tracks[0]]);
    expect(await removingAlbumIds(db)).toEqual([]);
  });

  it("finishes a removal left marked by a quit on the next start", async () => {
    const core = createCore({ db, fetch: async () => new Response("") });
    await core.finishAlbumRemovals();
    await core.removeAlbumLater(b.id);
    // The app quits (or is killed) inside the Undo window; the next start:
    const next = createCore({ db, fetch: async () => new Response("") });
    await next.finishAlbumRemovals([]); // waits for the start-up pass queued before it
    expect(await next.album(b.id)).toBeNull();
    expect(await removingAlbumIds(db)).toEqual([]);
    expect((await next.albums()).map((x) => x.id)).toEqual([a.id]);
  });
});
