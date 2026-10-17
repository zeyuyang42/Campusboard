import type { Db } from "../db/Db.js";
import * as jobs from "../db/repos/jobs.js";
import { albumUrlsInLibrary } from "../db/repos/albums.js";
import type { FetchQueue } from "../scrape/http.js";
import { normalizeBandcampUrl } from "../scrape/url.js";
import { parseMusicPage } from "../scrape/parseMusic.js";
import { parseTralbumPage } from "../scrape/parseTralbum.js";
import { ScrapeError } from "../scrape/errors.js";
import { upsertTralbum } from "./importService.js";
import { cachedFetchText } from "./pageCache.js";
import type { Job } from "../types.js";

function safeReleaseUrl(u: string): string | null {
  try {
    const n = normalizeBandcampUrl(u);
    return n.kind === "artist" ? null : n.url;
  } catch {
    return null;
  }
}

export interface ImportRequest {
  url: string;
  force?: boolean; // re-import discography items that are already in the library
}

export interface ImportSelectionRequest {
  /** Album/track URLs chosen on a browse page. */
  urls: string[];
  /** Shown as the job's source, e.g. the artist page URL. */
  label: string;
}

/**
 * Processes import jobs one at a time. Lives for the whole app session; on
 * construction it re-queues jobs that were running when the app last closed.
 */
export class JobRunner {
  private running = false;
  private forceFlags = new Map<number, boolean>();
  private ready: Promise<void>;

  constructor(private db: Db, private queue: FetchQueue, private onChange: () => void = () => {}) {
    this.ready = jobs.resetStaleJobs(db).then(() => this.kick());
  }

  /** Validate the URL, create a job and start processing in the background. */
  async enqueue(req: ImportRequest): Promise<Job> {
    const n = normalizeBandcampUrl(req.url);
    const job = n.kind === "artist"
      ? await jobs.createJob(this.db, "discography", n.url, [])
      : await jobs.createJob(this.db, n.kind, n.url, [n.url]);
    this.forceFlags.set(job.id, !!req.force);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /** Import a hand-picked set of album/track URLs as one job. */
  async enqueueSelection(req: ImportSelectionRequest): Promise<Job> {
    const urls = [...new Set(req.urls.map((u) => normalizeBandcampUrl(u)).filter((n) => n.kind !== "artist").map((n) => n.url))];
    if (!urls.length) throw new ScrapeError("invalid_url", "Nothing selected to import");
    const job = await jobs.createJob(this.db, "selection", req.label, urls);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  whenReady(): Promise<void> { return this.ready; }

  async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = await jobs.nextQueuedJob(this.db); job; job = await jobs.nextQueuedJob(this.db)) {
        await this.process(job);
      }
    } finally {
      this.running = false;
      this.onChange();
    }
  }

  private async process(job: Job): Promise<void> {
    await jobs.setJobStatus(this.db, job.id, "running");
    this.onChange();
    try {
      if (job.kind === "discography" && job.total === 0) {
        const origin = new URL(job.input_url).origin;
        const html = await this.fetchForJob(job.id, job.input_url);
        if (html === null) return;
        const parsed = parseMusicPage(html, origin);
        const have = await albumUrlsInLibrary(this.db);
        const force = this.forceFlags.get(job.id) ?? false;
        // Release links come from page markup: queue only URLs that pass the same check as pasted ones.
        const urls = [...new Set(parsed.items.map((i) => safeReleaseUrl(i.url)).filter((u): u is string => !!u))].filter((u) => force || !have.has(u));
        await jobs.addJobItems(this.db, job.id, urls);
        if (urls.length === 0) {
          await jobs.setJobStatus(this.db, job.id, "done", parsed.items.length ? "Everything from this artist is already in your library" : "No releases found on this page");
          return;
        }
      }
      let challenged = false;
      for (let item = await jobs.nextQueuedItem(this.db, job.id); item; item = await jobs.nextQueuedItem(this.db, job.id)) {
        if ((await jobs.jobStatus(this.db, job.id)) === "cancelled") return;
        try {
          const html = await this.fetchForJob(job.id, item.url);
          if (html === null) return;
          const albumId = await upsertTralbum(this.db, parseTralbumPage(html));
          await jobs.setItemResult(this.db, item.id, job.id, true, albumId, null);
        } catch (e) {
          const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
          console.error(`[job ${job.id}] ${item.url}: ${msg}`);
          // A challenge on the retry fails just this item. The gate has already doubled the
          // cooldown, and the next item waits that out before anything else goes to Bandcamp.
          await jobs.setItemResult(this.db, item.id, job.id, false, null, msg);
          if (e instanceof ScrapeError && e.code === "client_challenge") challenged = true;
        }
        this.onChange();
      }
      const final = (await jobs.getJob(this.db, job.id, false))!;
      if (final.status === "cancelled") return;
      const allFailed = final.total > 0 && final.done === 0;
      // Keep the clear challenge message when that is why nothing imported.
      const why = challenged ? "[client_challenge] Bandcamp kept returning its bot check" : "Every item failed to import";
      await jobs.setJobStatus(this.db, job.id, allFailed ? "failed" : "done", allFailed ? why : null);
    } catch (e) {
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      console.error(`[job ${job.id}] ${msg}`);
      await jobs.setJobStatus(this.db, job.id, "failed", msg);
    } finally {
      this.forceFlags.delete(job.id);
      this.onChange();
    }
  }

  /**
   * Fetch for a job, honouring the challenge cooldown. While a cooldown runs the job goes
   * back to "queued" and its items stay queued; a challenge on this fetch waits out the
   * new cooldown and retries once. Returns null if the job was cancelled while paused.
   */
  private async fetchForJob(jobId: number, url: string): Promise<string | null> {
    for (let challenges = 0; ;) {
      if (!(await this.waitOutCooldown(jobId))) return null;
      try {
        return await cachedFetchText(this.db, this.queue, url);
      } catch (e) {
        if (!(e instanceof ScrapeError)) throw e;
        // Another request tripped the gate while this one waited in the queue: not an attempt.
        if (e.code === "challenge_cooldown") continue;
        if (e.code === "client_challenge" && challenges++ === 0) continue;
        throw e;
      }
    }
  }

  /** Wait for any challenge cooldown to end. False if the job was cancelled meanwhile. */
  private async waitOutCooldown(jobId: number): Promise<boolean> {
    const gate = this.queue.gate;
    await gate.ready();
    if (!gate.until()) return (await jobs.jobStatus(this.db, jobId)) !== "cancelled";
    if ((await jobs.jobStatus(this.db, jobId)) === "running") await jobs.setJobStatus(this.db, jobId, "queued");
    this.onChange();
    await gate.waitClear();
    if ((await jobs.jobStatus(this.db, jobId)) === "cancelled") return false;
    await jobs.setJobStatus(this.db, jobId, "running");
    this.onChange();
    return true;
  }

  async cancel(id: number): Promise<boolean> {
    const s = await jobs.jobStatus(this.db, id);
    if (!s || s === "done" || s === "failed" || s === "cancelled") return false;
    await jobs.setJobStatus(this.db, id, "cancelled");
    this.onChange();
    return true;
  }
}
