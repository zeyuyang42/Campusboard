import type { Db } from "../db/connection.js";
import * as jobs from "../db/repos/jobs.js";
import { albumUrlsInLibrary } from "../db/repos/albums.js";
import { fetchQueue, normalizeBandcampUrl, parseMusicPage, parseTralbumPage, ScrapeError } from "../scrape/index.js";
import { upsertTralbum } from "./importService.js";
import type { Job } from "@bc/shared";

export interface ImportRequest {
  url: string;
  force?: boolean; // re-import discography items that are already in the library
}

export class JobRunner {
  private running = false;

  constructor(private db: Db) {
    jobs.resetStaleJobs(db);
  }

  /** Validate the URL, create a job and start processing in the background. */
  enqueue(req: ImportRequest): Job {
    const n = normalizeBandcampUrl(req.url);
    const job = n.kind === "artist" ? jobs.createJob(this.db, "discography", n.url, []) : jobs.createJob(this.db, n.kind, n.url, [n.url]);
    if (req.force) this.db.prepare("UPDATE jobs SET error = NULL WHERE id = ?").run(job.id);
    this.forceFlags.set(job.id, !!req.force);
    void this.kick();
    return jobs.getJob(this.db, job.id)!;
  }

  private forceFlags = new Map<number, boolean>();

  async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = jobs.nextQueuedJob(this.db); job; job = jobs.nextQueuedJob(this.db)) {
        await this.process(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(job: Job): Promise<void> {
    jobs.setJobStatus(this.db, job.id, "running");
    try {
      if (job.kind === "discography" && job.total === 0) {
        const origin = new URL(job.input_url).origin;
        const html = await fetchQueue.fetchText(job.input_url);
        const parsed = parseMusicPage(html, origin);
        const have = albumUrlsInLibrary(this.db);
        const force = this.forceFlags.get(job.id) ?? false;
        const urls = parsed.items.filter((u) => force || !have.has(u));
        jobs.addJobItems(this.db, job.id, urls);
        if (urls.length === 0) {
          jobs.setJobStatus(this.db, job.id, "done", parsed.items.length ? "All items already in library" : "No items found");
          return;
        }
      }
      for (let item = jobs.nextQueuedItem(this.db, job.id); item; item = jobs.nextQueuedItem(this.db, job.id)) {
        if (jobs.jobStatus(this.db, job.id) === "cancelled") return;
        try {
          const html = await fetchQueue.fetchText(item.url);
          const albumId = upsertTralbum(this.db, parseTralbumPage(html));
          jobs.setItemResult(this.db, item.id, job.id, true, albumId, null);
        } catch (e) {
          const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
          console.error(`[job ${job.id}] ${item.url}: ${msg}`);
          jobs.setItemResult(this.db, item.id, job.id, false, null, msg);
          if (e instanceof ScrapeError && e.code === "client_challenge") {
            jobs.setJobStatus(this.db, job.id, "failed", "Bandcamp served a bot challenge; wait a while and retry");
            return;
          }
        }
      }
      const final = jobs.getJob(this.db, job.id, false)!;
      if (final.status === "cancelled") return;
      jobs.setJobStatus(this.db, job.id, final.total > 0 && final.done === 0 ? "failed" : "done", final.total > 0 && final.done === 0 ? "Every item failed" : null);
    } catch (e) {
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      console.error(`[job ${job.id}] ${msg}`);
      jobs.setJobStatus(this.db, job.id, "failed", msg);
    } finally {
      this.forceFlags.delete(job.id);
    }
  }

  cancel(id: number): boolean {
    const s = jobs.jobStatus(this.db, id);
    if (!s || s === "done" || s === "failed" || s === "cancelled") return false;
    jobs.setJobStatus(this.db, id, "cancelled");
    return true;
  }
}
