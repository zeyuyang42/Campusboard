import type { Db } from "../connection.js";
import { now } from "../connection.js";
import type { Job, JobItem, JobKind, JobStatus } from "@bc/shared";

export function createJob(db: Db, kind: JobKind, inputUrl: string, itemUrls: string[]): Job {
  const job = db.prepare("INSERT INTO jobs (kind, input_url, total) VALUES (?, ?, ?) RETURNING *").get(kind, inputUrl, itemUrls.length) as unknown as Job;
  const ins = db.prepare("INSERT INTO job_items (job_id, url) VALUES (?, ?)");
  for (const u of itemUrls) ins.run(job.id, u);
  return job;
}

export function addJobItems(db: Db, jobId: number, urls: string[]): void {
  const ins = db.prepare("INSERT INTO job_items (job_id, url) VALUES (?, ?)");
  for (const u of urls) ins.run(jobId, u);
  db.prepare("UPDATE jobs SET total = (SELECT COUNT(*) FROM job_items WHERE job_id = ?), updated_at = ? WHERE id = ?").run(jobId, now(), jobId);
}

export function listJobs(db: Db, limit = 50): Job[] {
  return db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as Job[];
}

export function getJob(db: Db, id: number, withItems = true): Job | null {
  const j = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as Job | undefined;
  if (!j) return null;
  if (withItems) j.items = db.prepare("SELECT id, url, status, album_id, error FROM job_items WHERE job_id = ? ORDER BY id").all(id) as unknown as JobItem[];
  return j;
}

export function nextQueuedJob(db: Db): Job | null {
  return (db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as unknown as Job | undefined) ?? null;
}

export function setJobStatus(db: Db, id: number, status: JobStatus, error: string | null = null): void {
  db.prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
}

export function jobStatus(db: Db, id: number): JobStatus | null {
  return (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: JobStatus } | undefined)?.status ?? null;
}

export function nextQueuedItem(db: Db, jobId: number): JobItem | null {
  return (db.prepare("SELECT id, url, status, album_id, error FROM job_items WHERE job_id = ? AND status = 'queued' ORDER BY id LIMIT 1").get(jobId) as unknown as JobItem | undefined) ?? null;
}

export function setItemResult(db: Db, itemId: number, jobId: number, ok: boolean, albumId: number | null, error: string | null): void {
  db.prepare("UPDATE job_items SET status = ?, album_id = ?, error = ? WHERE id = ?").run(ok ? "done" : "failed", albumId, error, itemId);
  db.prepare(`UPDATE jobs SET ${ok ? "done = done + 1" : "failed = failed + 1"}, updated_at = ? WHERE id = ?`).run(now(), jobId);
}

export function resetStaleJobs(db: Db): void {
  db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
  db.exec("UPDATE job_items SET status = 'queued' WHERE status = 'running'");
}
