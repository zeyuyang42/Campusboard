import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ScrapeError } from "../src/scrape/errors.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { OfflineService, isOfflineFileName, offlineFileName, type OfflineFiles } from "../src/services/offline.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { exportLibrary } from "../src/services/libraryTransfer.js";
import { createCore } from "../src/core.js";
import * as jobs from "../src/db/repos/jobs.js";
import { ChallengeGate } from "../src/scrape/challenge.js";
import type { Job } from "../src/types.js";

const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const MP3_BYTES = 4096;

/** An offline folder in memory. `failWrites` makes the next write throw part way. */
class MemFiles implements OfflineFiles {
  files = new Map<string, Uint8Array>();
  calls: string[] = [];
  failWrites = 0;
  async write(name: string, body: ReadableStream<Uint8Array>) {
    this.calls.push(`write ${name}`);
    if (this.failWrites > 0) { this.failWrites--; this.files.set(name, new Uint8Array(10)); await body.cancel(); throw new Error("disk full"); }
    this.files.set(name, new Uint8Array(await new Response(body).arrayBuffer()));
  }
  async rename(from: string, to: string) {
    const f = this.files.get(from);
    if (!f) throw new Error(`no ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }
  async remove(name: string) { this.calls.push(`remove ${name}`); this.files.delete(name); }
  async exists(name: string) { this.calls.push(`exists ${name}`); return this.files.has(name); }
  async list() { return [...this.files.keys()]; }
  url(name: string) { return `asset://localhost/offline/${name}`; }
}

/**
 * A fake Bandcamp: the album page from the fixture, and an mp3 of MP3_BYTES for every stream
 * URL. `cdn` overrides the CDN's answer per call (its index among CDN requests).
 */
function fakeBandcamp(cdn: (n: number, url: string) => Response | null = () => null) {
  const calls: string[] = [];
  let cdnCalls = 0;
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.includes("bcbits.com/stream/")) {
      const r = cdn(cdnCalls++, url);
      if (r) return r;
      return new Response(new Uint8Array(MP3_BYTES).fill(7), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(MP3_BYTES) } });
    }
    // As Bandcamp would serve it now: stream links valid for a day (the fixture's have expired).
    if (url === ALBUM) return new Response(fixture("album").replace(/ts=\d+/g, `ts=${Math.floor(Date.now() / 1000) + 86_400}`), { status: 200 });
    return new Response("missing", { status: 404 });
  };
  return { fetch, calls, cdnCount: () => cdnCalls };
}

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settled = (db: NodeDb, id: number) => async () => ["done", "failed", "cancelled"].includes((await jobs.jobStatus(db, id))!);

let db: NodeDb;
let albumId: number;
beforeEach(async () => {
  db = new NodeDb();
  albumId = await upsertTralbum(db, parseTralbumPage(fixture("album")));
});

function setup(cdn?: (n: number, url: string) => Response | null) {
  const bc = fakeBandcamp(cdn);
  const files = new MemFiles();
  const queue = new FetchQueue(bc.fetch, 0);
  const offline = new OfflineService(db, queue, files);
  const runner = new JobRunner(db, queue, () => {}, offline);
  return { bc, files, queue, offline, runner };
}

const streamable = async () => (await db.select<{ id: number; track_id: number }>("SELECT id, track_id FROM tracks WHERE album_id = ? AND streamable = 1 ORDER BY track_num", [albumId]));

describe("offline copies (#2)", () => {
  it("downloads an album's tracks one at a time as a download job and records each copy", async () => {
    const { bc, files, offline, runner } = setup();
    const want = await streamable();
    expect(want.length).toBeGreaterThan(1);
    const job = (await runner.enqueueDownload(albumId))!;
    expect(job.kind).toBe("download");
    expect(job.total).toBe(want.length);
    await waitFor(settled(db, job.id));
    const done = (await jobs.getJob(db, job.id))!;
    expect(done).toMatchObject({ status: "done", done: want.length, failed: 0 });
    // Every file named by Bandcamp track id, complete (no .part left), and recorded.
    expect([...files.files.keys()].sort()).toEqual(want.map((t) => offlineFileName(t.track_id)).sort());
    const rows = await db.select<{ local_path: string; bytes: number; quality: string }>(
      "SELECT t.local_path, f.bytes, f.quality FROM tracks t JOIN track_files f ON f.track_id = t.id WHERE t.album_id = ?", [albumId]);
    expect(rows).toHaveLength(want.length);
    expect(rows.every((r) => r.bytes === MP3_BYTES && r.quality === "mp3-128" && isOfflineFileName(r.local_path))).toBe(true);
    // Only the CDN was asked for audio, once per track (plus album page refreshes for stale URLs).
    expect(bc.cdnCount()).toBe(want.length);
    expect(await offline.stats()).toMatchObject({ tracks: want.length, albums: 1, bytes: want.length * MP3_BYTES, cap_mb: null, available: true });
    // Nothing left to do: a second request queues nothing.
    expect(await runner.enqueueDownload(albumId)).toBeNull();
  });

  it("plays the local file when it is there, and forgets a copy whose file went missing", async () => {
    const { files, offline } = setup();
    const [t] = await streamable();
    expect(await offline.localUrl(t.id)).toBeNull();
    expect(await offline.download(t.id)).toBe("saved");
    expect(await offline.localUrl(t.id)).toBe(`asset://localhost/offline/${t.track_id}.mp3`);
    expect(await offline.download(t.id)).toBe("have");
    files.files.clear();
    expect(await offline.localUrl(t.id)).toBeNull();
    expect(await db.get("SELECT local_path FROM tracks WHERE id = ?", [t.id])).toEqual({ local_path: null });
    expect(await db.get("SELECT COUNT(*) AS n FROM track_files")).toEqual({ n: 0 });
  });

  it("never hands the folder a name it didn't make", async () => {
    const { files, offline } = setup();
    const [t] = await streamable();
    await db.run("UPDATE tracks SET local_path = '../library.db' WHERE id = ?", [t.id]);
    expect(await offline.localUrl(t.id)).toBeNull();
    await offline.remove([t.id]);
    expect(files.calls.filter((c) => c.includes(".."))).toEqual([]);
    expect(isOfflineFileName("123.mp3")).toBe(true);
    for (const bad of ["../1.mp3", "/tmp/1.mp3", "1.mp3/..", "a.mp3", "1.mp3.part", null]) expect(isOfflineFileName(bad)).toBe(false);
  });

  it("retries once with a freshly scraped URL when the CDN refuses the stored one", async () => {
    const { bc, offline } = setup((n) => (n === 0 ? new Response("gone", { status: 410, headers: { "content-type": "text/plain" } }) : null));
    const [t] = await streamable();
    // A fresh-looking URL, so the first attempt uses it without a page fetch.
    await db.run("UPDATE tracks SET stream_expires_at = ? WHERE id = ?", [Date.now() + 10 * 3600_000, t.id]);
    expect(await offline.download(t.id)).toBe("saved");
    expect(bc.cdnCount()).toBe(2);
    expect(bc.calls.filter((u) => u === ALBUM)).toHaveLength(1); // the forced refresh
  });

  it("keeps no partial file when a download is cut short", async () => {
    const short = () => new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(MP3_BYTES) } });
    const { files, offline } = setup(() => short());
    const [t] = await streamable();
    const err = await offline.download(t.id).catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.code).toBe("fetch_failed");
    expect(err.detail).toMatchObject({ network: true });
    expect(files.files.size).toBe(0);
    expect(await db.get("SELECT local_path FROM tracks WHERE id = ?", [t.id])).toEqual({ local_path: null });
  });

  it("leaves no file behind when the album is removed while its track downloads", async () => {
    const { files, offline } = setup();
    const [t] = await streamable();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const write = files.write.bind(files);
    files.write = async (name, body) => { await held; return write(name, body); };
    const pending = offline.download(t.id).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await db.run("DELETE FROM albums WHERE id = ?", [albumId]);
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(files.files.size).toBe(0);
  });

  it("Remove download while a track is in flight stops it and keeps nothing (review #77)", async () => {
    const { files, offline, runner } = setup();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => { reached = r; });
    const write = files.write.bind(files);
    files.write = async (name, body) => { reached(); await held; return write(name, body); };
    const job = (await runner.enqueueDownload(albumId))!;
    await atWrite;
    expect(offline.downloading()).toHaveLength(1);
    await runner.cancelDownloads(ALBUM);
    const removing = offline.removeAlbum(albumId);
    release();
    await removing;
    await waitFor(async () => offline.downloading().length === 0 && !(await db.get("SELECT 1 FROM jobs WHERE status = 'running'")));
    expect((await jobs.getJob(db, job.id))!.status).toBe("cancelled");
    expect(files.files.size).toBe(0);
    expect(await db.get("SELECT COUNT(*) AS n FROM tracks WHERE local_path IS NOT NULL")).toEqual({ n: 0 });
    expect(await db.get("SELECT COUNT(*) AS n FROM track_files")).toEqual({ n: 0 });
  });

  it("a CDN that keeps refusing costs one forced page fetch per job, then fails the rest", async () => {
    const { bc, runner } = setup(() => new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    const want = await streamable();
    // Fresh-looking URLs, so only the forced re-scrape fetches the album page.
    await db.run("UPDATE tracks SET stream_expires_at = ?", [Date.now() + 10 * 3600_000]);
    const job = (await runner.enqueueDownload(albumId))!;
    await waitFor(settled(db, job.id));
    const j = (await jobs.getJob(db, job.id))!;
    expect(bc.calls.filter((u) => u === ALBUM)).toHaveLength(1);
    // The first track twice (the second time with the fresh link), then the second track: two in a row.
    expect(bc.cdnCount()).toBe(3);
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/^\[cdn_refused\]/);
    expect(j.items![0].error).toMatch(/fetch_failed/);
    expect(j.items!.slice(1).every((i) => /cdn_refused/.test(i.error ?? ""))).toBe(true);
    expect(j.items).toHaveLength(want.length);
  });

  it("a single refused track fails alone; the job goes on", async () => {
    const refuse = new Set([0, 1, 3]); // track 1 (and its forced retry), then track 3
    const { bc, files, runner } = setup((n) => (refuse.has(n) ? new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }) : null));
    const want = await streamable();
    await db.run("UPDATE tracks SET stream_expires_at = ?", [Date.now() + 10 * 3600_000]);
    const job = (await runner.enqueueDownload(albumId))!;
    await waitFor(settled(db, job.id));
    const j = (await jobs.getJob(db, job.id))!;
    expect(j).toMatchObject({ status: "done", failed: 2, done: want.length - 2 });
    expect(j.items!.some((i) => /cdn_refused/.test(i.error ?? ""))).toBe(false);
    expect(files.files.size).toBe(want.length - 2);
    expect(bc.calls.filter((u) => u === ALBUM)).toHaveLength(1);
  });

  it("the sweep leaves a download in progress alone", async () => {
    const { files, offline } = setup();
    const [t] = await streamable();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const midWrite = new Promise<void>((r) => { reached = r; });
    files.write = async (name, body) => {
      files.files.set(name, new Uint8Array(1)); // partly written
      reached();
      await held;
      files.files.set(name, new Uint8Array(await new Response(body).arrayBuffer()));
    };
    const pending = offline.download(t.id);
    await midWrite;
    files.files.set("5.mp3.part", new Uint8Array(1)); // a stale one from an old run
    expect(await offline.sweep()).toBe(1);
    expect(files.files.has(`${t.track_id}.mp3.part`)).toBe(true);
    release();
    expect(await pending).toBe("saved");
    expect([...files.files.keys()]).toEqual([`${t.track_id}.mp3`]);
  });

  it("without a Content-Length, a file far shorter than the track is refused", async () => {
    const noLength = (n: number) => () => new Response(new Uint8Array(n), { status: 200, headers: { "content-type": "audio/mpeg" } });
    const [t] = await streamable();
    // 10 s of mp3-128 is ~160 kB. A fresh URL, so no page refresh rewrites the duration.
    await db.run("UPDATE tracks SET duration = 10, stream_expires_at = ? WHERE id = ?", [Date.now() + 10 * 3600_000, t.id]);
    const short = setup(noLength(50_000));
    const err = await short.offline.download(t.id).catch((e) => e);
    expect(err.code).toBe("fetch_failed");
    expect(err.message).toMatch(/incomplete/);
    expect(short.files.files.size).toBe(0);
    const whole = setup(noLength(160_000));
    expect(await whole.offline.download(t.id)).toBe("saved");
  });

  it("labels a failure writing the file as a disk error, not the network", async () => {
    const { files, offline, runner } = setup();
    const [t] = await streamable();
    files.write = async (_name, body) => { await body.cancel(); throw new Error("ENOSPC: no space left on device, write"); };
    const err = await offline.download(t.id).catch((e) => e);
    expect(err.code).toBe("disk_error");
    expect(err.detail).toEqual({ full: true });
    // In a job, a full disk stops the rest like the size limit.
    const job = (await runner.enqueueDownload(albumId))!;
    await waitFor(settled(db, job.id));
    expect((await jobs.getJob(db, job.id))!.error).toMatch(/^\[disk_error\]/);
  });

  it("stops at the size limit and fails the rest with storage_full", async () => {
    const { files, offline, runner } = setup();
    await offline.setCap(0.001);
    expect((await offline.settings()).cap_mb).toBe(null); // rounds to 0: no limit
    await offline.setCap(1);
    await db.run("INSERT INTO track_files (track_id, bytes, quality) SELECT id, 1000000, 'mp3-128' FROM tracks WHERE album_id = ? LIMIT 1", [albumId]);
    await db.run("UPDATE tracks SET local_path = track_id || '.mp3' WHERE id = (SELECT track_id FROM track_files)");
    files.files.set(`${(await db.get<{ track_id: number }>("SELECT t.track_id FROM tracks t JOIN track_files f ON f.track_id = t.id"))!.track_id}.mp3`, new Uint8Array(1));
    const job = (await runner.enqueueDownload(albumId))!;
    await waitFor(settled(db, job.id));
    const j = (await jobs.getJob(db, job.id))!;
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/^\[storage_full\]/);
    expect(j.items!.every((i) => i.status === "failed" && /storage_full/.test(i.error ?? ""))).toBe(true);
    expect(files.files.size).toBe(1);
  });

  it("is cancellable between tracks and resumes a job left running by a quit", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const { files, runner } = setup();
    const want = await streamable();
    // Hold the first track's write until the job is cancelled.
    const write = files.write.bind(files);
    files.write = async (name, body) => { if (first) { first = false; await held; } return write(name, body); };
    const job = (await runner.enqueueDownload(albumId))!;
    await waitFor(async () => files.calls.length > 0 || !first);
    await runner.cancel(job.id);
    release();
    await waitFor(async () => !(await db.get("SELECT 1 FROM jobs WHERE status = 'running'")));
    await new Promise((r) => setTimeout(r, 20));
    // The track in flight finishes; nothing after it starts.
    expect(files.files.size).toBeLessThanOrEqual(1);
    expect((await jobs.getJob(db, job.id))!.status).toBe("cancelled");

    // A job "running" when the app quit, with a .part left behind: the next runner resumes it
    // and the sweep removes the stale part.
    const db2Job = await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, status, total) VALUES ('download', ?, 'running', ?) RETURNING id", [ALBUM, want.length]);
    for (const t of want) await db.run("INSERT INTO job_items (job_id, url, status) VALUES (?, ?, 'queued')", [db2Job!.id, `${ALBUM}#track=${t.track_id}`]);
    await db.run("UPDATE job_items SET status = 'running' WHERE id = (SELECT MIN(id) FROM job_items WHERE job_id = ?)", [db2Job!.id]);
    files.files.set("999.mp3.part", new Uint8Array(5));
    const again = setupWith(files);
    await again.offline.sweep();
    expect(files.files.has("999.mp3.part")).toBe(false);
    await again.runner.whenReady();
    await waitFor(settled(db, db2Job!.id));
    expect((await jobs.getJob(db, db2Job!.id))!).toMatchObject({ status: "done", done: want.length });
    expect(files.files.size).toBe(want.length);
  });

  it("waits out a challenge cooldown before downloading", async () => {
    const bc = fakeBandcamp();
    const files = new MemFiles();
    const gate = new ChallengeGate();
    await gate.trip(Date.now() - 59_950); // ends in ~50 ms
    const queue = new FetchQueue(bc.fetch, 0, gate);
    const offline = new OfflineService(db, queue, files);
    const runner = new JobRunner(db, queue, () => {}, offline);
    const job = (await runner.enqueueDownload(albumId))!;
    expect(bc.calls).toEqual([]);
    await waitFor(settled(db, job.id), 8000);
    expect((await jobs.getJob(db, job.id))!.status).toBe("done");
  });

  it("removes files with their album, with Remove download, and in the sweep; export leaves them out", async () => {
    const bc = fakeBandcamp();
    const files = new MemFiles();
    // createCore's queue keeps 1 request/s: two tracks with fresh URLs keep this test short.
    const keep = async () => {
      await db.run("DELETE FROM tracks WHERE album_id = ? AND id NOT IN (SELECT id FROM tracks WHERE album_id = ? AND streamable = 1 ORDER BY track_num LIMIT 2)", [albumId, albumId]);
      await db.run("UPDATE tracks SET stream_expires_at = ?", [Date.now() + 10 * 3600_000]);
    };
    await keep();
    let core = createCore({ db, fetch: bc.fetch, files });
    const job = (await core.downloadAlbum(albumId)) as Job;
    await waitFor(settled(db, job.id), 10_000);
    const n = (await streamable()).length;
    expect(files.files.size).toBe(n);
    expect((await core.albums("added", "downloaded")).map((a) => a.id)).toEqual([albumId]);
    expect((await core.albums())[0].downloaded_count).toBe(n);
    expect((await core.album(albumId))!.tracks.filter((t) => t.downloaded)).toHaveLength(n);
    expect((await core.tracks("")).filter((t) => t.downloaded)).toHaveLength(n);

    // The library file is about Bandcamp identity: no file names, sizes or paths.
    const text = JSON.stringify(await exportLibrary(db));
    expect(text).not.toMatch(/local_path|track_files|\.mp3/);

    // A stray file nobody names goes in the sweep; the copies stay.
    files.files.set("1.mp3", new Uint8Array(3));
    files.files.set(".DS_Store", new Uint8Array(3));
    await core.vacuumOrphans();
    expect(files.files.has("1.mp3")).toBe(false);
    expect(files.files.has(".DS_Store")).toBe(true);
    expect(files.files.size).toBe(n + 1);

    expect(await core.removeAlbumDownloads(albumId)).toBe(n);
    expect(files.files.size).toBe(1);
    expect((await core.offlineStats()).tracks).toBe(0);

    const job2 = (await core.downloadAlbum(albumId)) as Job;
    await waitFor(settled(db, job2.id), 10_000);
    expect(files.files.size).toBe(n + 1);
    expect(await core.deleteAlbum(albumId)).toBe(true);
    expect([...files.files.keys()]).toEqual([".DS_Store"]);

    // Remove all: every copy and any job still downloading.
    albumId = await upsertTralbum(db, parseTralbumPage(fixture("album")));
    await keep();
    core = createCore({ db, fetch: bc.fetch, files });
    const job3 = (await core.downloadAlbum(albumId)) as Job;
    await waitFor(settled(db, job3.id), 10_000);
    expect(await core.removeAllDownloads()).toBe(n);
    expect([...files.files.keys()]).toEqual([".DS_Store"]);
  }, 30_000);

  it("without an offline folder downloads are refused and playback asks for nothing", async () => {
    const core = createCore({ db, fetch: fakeBandcamp().fetch });
    const err = await core.downloadAlbum(albumId).catch((e) => e);
    expect(err.code).toBe("offline_unavailable");
    expect(await core.localTrackUrl((await streamable())[0].id)).toBeNull();
    expect((await core.offlineStats()).available).toBe(false);
  });
});

function setupWith(files: MemFiles) {
  const queue = new FetchQueue(fakeBandcamp().fetch, 0);
  const offline = new OfflineService(db, queue, files);
  return { offline, runner: new JobRunner(db, queue, () => {}, offline) };
}

describe("FetchQueue network errors", () => {
  it("marks a request that never got an answer as a network failure", async () => {
    const q = new FetchQueue(async () => { throw new TypeError("Load failed"); }, 0);
    const err = await q.fetchText(ALBUM, {}, 0).catch((e) => e);
    expect(err.code).toBe("fetch_failed");
    expect(err.detail).toEqual({ network: true });
    const http = new FetchQueue(async () => new Response("no", { status: 503 }), 0);
    const err2 = await http.fetchText(ALBUM, {}, 0).catch((e) => e);
    expect(err2.code).toBe("fetch_failed");
    expect(err2.detail).toBeUndefined();
  });
});
