import { describe, it, expect } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import type { Db } from "../src/db/Db.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import * as jobs from "../src/db/repos/jobs.js";

const ALBUM_A = "https://someone.bandcamp.com/album/first";
const ALBUM_B = "https://someone.bandcamp.com/album/second";
const BAD = "https://someone.bandcamp.com/album/bad";

/** Serves the album fixture, except for URLs containing "bad", which 404 (no retries). */
const albumFetch = async (url: string) => {
  if (url.includes("bad")) return new Response("gone", { status: 404 });
  return new Response(fixture("album"), { status: 200 });
};

/** A Db that runs `hook` before statements matching `match`, so tests can wedge work in between. */
class HookedDb implements Db {
  constructor(readonly inner: NodeDb, private match: RegExp, private hook: (sql: string) => Promise<unknown> | unknown) {}
  private async before(sql: string) { if (this.match.test(sql)) await this.hook(sql); }
  async select<T>(sql: string, params?: unknown[]) { await this.before(sql); return this.inner.select<T>(sql, params); }
  async get<T>(sql: string, params?: unknown[]) { await this.before(sql); return this.inner.get<T>(sql, params); }
  async run(sql: string, params?: unknown[]) { await this.before(sql); return this.inner.run(sql, params); }
}

async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const statusOf = async (db: Db, id: number) => (await jobs.jobStatus(db, id))!;

describe("job creation race (#49)", () => {
  it("a runner pass between the job insert and its items never sees the job", async () => {
    const raw = new NodeDb();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atItems = new Promise<void>((r) => { reached = r; });
    // Hold the job_items insert until the test lets it go.
    const db = new HookedDb(raw, /^INSERT INTO job_items/, async () => { reached(); await held; });
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    // Not awaiting whenReady(): this enqueue races the startup kick.
    const enqueued = runner.enqueue({ url: ALBUM_A });
    await atItems;
    const row = (await raw.get<{ id: number; status: string }>("SELECT id, status FROM jobs"))!;
    expect(row.status).toBe("pending");
    // The startup kick and any other pass run now, while the items are missing.
    await runner.whenReady();
    await runner.kick();
    expect(await statusOf(raw, row.id)).toBe("pending");
    expect(await jobs.listJobs(raw)).toEqual([]);

    release();
    const job = await enqueued;
    expect(job.id).toBe(row.id);
    await until(async () => (await statusOf(raw, job.id)) === "done");
    const done = (await jobs.getJob(raw, job.id))!;
    expect(done.done).toBe(1);
    expect(done.items![0].status).toBe("done");
  });

  it("a cancel while the job is pending wins over the flip to queued", async () => {
    const raw = new NodeDb();
    let runner!: JobRunner;
    let cancelled = false;
    const db = new HookedDb(raw, /^INSERT INTO job_items/, async () => {
      if (cancelled) return;
      cancelled = true;
      const id = (await raw.get<{ id: number }>("SELECT id FROM jobs"))!.id;
      expect(await runner.cancel(id)).toBe(true);
    });
    runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    const job = await runner.enqueue({ url: ALBUM_A });
    expect(job.status).toBe("cancelled");
  });

  it("an item that lands after the loop found none sends the job back to the queue, not to failed", async () => {
    const raw = new NodeDb();
    let late = false;
    // The first time the runner looks for work the job's item isn't there; it lands right after.
    const db = new HookedDb(raw, /^$/, () => {});
    const get = db.get.bind(db);
    db.get = async <T,>(sql: string, params?: unknown[]): Promise<T | null> => {
      if (late || !/FROM job_items WHERE job_id = \? AND status = 'queued'/.test(sql)) return get<T>(sql, params);
      late = true;
      const items = await raw.select<{ job_id: number; url: string }>("SELECT job_id, url FROM job_items");
      await raw.run("DELETE FROM job_items");
      const r = await get<T>(sql, params);
      for (const i of items) await raw.run("INSERT INTO job_items (job_id, url) VALUES (?, ?)", [i.job_id, i.url]);
      return r;
    };
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    await runner.whenReady();
    const job = await runner.enqueue({ url: ALBUM_A });
    await until(async () => ["done", "failed"].includes(await statusOf(raw, job.id)));
    const final = (await jobs.getJob(raw, job.id))!;
    expect(final.status).toBe("done");
    expect(final.done).toBe(1);
    expect(final.error).toBeNull();
  });
});

describe("crash between the job insert and its items", () => {
  it("resetStaleJobs queues pending jobs that have items or need none, and removes the rest", async () => {
    const db = new NodeDb();
    const ins = async (kind: string, total: number) =>
      (await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total, status) VALUES (?, ?, ?, 'pending') RETURNING id", [kind, "x", total]))!.id;
    // Items cut short between chunks: 1 of 3 landed.
    const partial = await ins("selection", 3);
    await db.run("INSERT INTO job_items (job_id, url) VALUES (?, ?)", [partial, ALBUM_A]);
    const discography = await ins("discography", 0);
    const orphan = await ins("album", 1);
    expect((await jobs.listJobs(db)).map((j) => j.id)).toEqual([]);

    await jobs.resetStaleJobs(db);
    await jobs.resetStaleJobs(db); // idempotent

    const p = (await jobs.getJob(db, partial))!;
    expect(p.status).toBe("queued");
    expect(p.total).toBe(1);
    expect((await jobs.getJob(db, discography))!.status).toBe("queued");
    expect(await jobs.getJob(db, orphan)).toBeNull();
    expect((await jobs.listJobs(db)).map((j) => j.id).sort()).toEqual([partial, discography].sort());
  });

  it("the runner resumes a recovered job on startup", async () => {
    const db = new NodeDb();
    const id = (await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total, status) VALUES ('album', ?, 1, 'pending') RETURNING id", [ALBUM_A]))!.id;
    await db.run("INSERT INTO job_items (job_id, url) VALUES (?, ?)", [id, ALBUM_A]);
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    await runner.whenReady();
    const job = (await jobs.getJob(db, id))!;
    expect(job.status).toBe("done");
    expect(job.done).toBe(1);
  });
});

describe("startup reset", () => {
  it("is retried once by the next enqueue when it failed at startup", async () => {
    const raw = new NodeDb();
    const stale = (await raw.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total, status) VALUES ('album', ?, 1, 'pending') RETURNING id", [ALBUM_A]))!.id;
    let resets = 0;
    const db = new HookedDb(raw, /^UPDATE jobs SET status = 'queued' WHERE status = 'running'/, () => {
      if (++resets === 1) throw new Error("database is locked");
    });
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    await runner.whenReady();
    expect(await statusOf(raw, stale)).toBe("pending");
    const job = await runner.enqueue({ url: ALBUM_B });
    expect(resets).toBe(2);
    // Removed (the new job may reuse its rowid): nothing is left pending.
    expect(await raw.get("SELECT id FROM jobs WHERE status = 'pending'")).toBeNull();
    expect(job.input_url).toBe(ALBUM_B);
    await until(async () => (await statusOf(raw, job.id)) === "done");
    await runner.enqueue({ url: ALBUM_A });
    expect(resets).toBe(2); // once only
  });
});

describe("job outcome", () => {
  it("is decided from the items, not from counters a crash left short", async () => {
    const db = new NodeDb();
    // A crash after the item was marked failed but before the job's counter was bumped.
    const id = (await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total) VALUES ('album', ?, 1) RETURNING id", [BAD]))!.id;
    await db.run("INSERT INTO job_items (job_id, url, status, error) VALUES (?, ?, 'failed', 'boom')", [id, BAD]);
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    await runner.whenReady();
    const j = (await jobs.getJob(db, id))!;
    expect(j.status).toBe("failed");
    expect([j.done, j.failed, j.total]).toEqual([0, 1, 1]);
  });

  const run = async (urls: string[]) => {
    const db = new NodeDb();
    const runner = new JobRunner(db, new FetchQueue(albumFetch, 0));
    await runner.whenReady();
    const job = await runner.enqueueSelection({ urls, label: "test" });
    await until(async () => ["done", "failed"].includes(await statusOf(db, job.id)));
    return (await jobs.getJob(db, job.id))!;
  };

  it("is done when only some items fail", async () => {
    const j = await run([ALBUM_A, BAD]);
    expect(j.status).toBe("done");
    expect([j.done, j.failed, j.total]).toEqual([1, 1, 2]);
  });

  it("is failed only when every item failed", async () => {
    const j = await run([BAD, `${BAD}-2`]);
    expect(j.status).toBe("failed");
    expect(j.error).toBe("Every item failed to import");
    expect([j.done, j.failed, j.total]).toEqual([0, 2, 2]);
  });

  it("is done when every item succeeded", async () => {
    const j = await run([ALBUM_A, ALBUM_B]);
    expect(j.status).toBe("done");
    expect(j.done).toBe(2);
  });
});
