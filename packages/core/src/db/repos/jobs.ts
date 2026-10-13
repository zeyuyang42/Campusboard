import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { Job, JobItem, JobKind, JobStatus } from "../../types.js";

export async function createJob(db: Db, kind: JobKind, inputUrl: string, itemUrls: string[]): Promise<Job> {
  const r = await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total) VALUES (?, ?, ?) RETURNING id", [kind, inputUrl, itemUrls.length]);
  if (itemUrls.length) await addJobItems(db, r!.id, itemUrls);
  return (await getJob(db, r!.id, false))!;
}

export async function addJobItems(db: Db, jobId: number, urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i += 200) {
    const chunk = urls.slice(i, i + 200);
    await db.run(`INSERT INTO job_items (job_id, url) VALUES ${chunk.map(() => "(?, ?)").join(",")}`, chunk.flatMap((u) => [jobId, u]));
  }
  await db.run("UPDATE jobs SET total = (SELECT COUNT(*) FROM job_items WHERE job_id = ?), updated_at = ? WHERE id = ?", [jobId, now(), jobId]);
}

export function listJobs(db: Db, limit = 50): Promise<Job[]> {
  return db.select<Job>("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", [limit]);
}

export async function getJob(db: Db, id: number, withItems = true): Promise<Job | null> {
  const j = await db.get<Job>("SELECT * FROM jobs WHERE id = ?", [id]);
  if (!j) return null;
  if (withItems) j.items = await db.select<JobItem>("SELECT id, url, status, album_id, error FROM job_items WHERE job_id = ? ORDER BY id", [id]);
  return j;
}

export function nextQueuedJob(db: Db): Promise<Job | null> {
  return db.get<Job>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
}

export async function setJobStatus(db: Db, id: number, status: JobStatus, error: string | null = null): Promise<void> {
  await db.run("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?", [status, error, now(), id]);
}

export async function jobStatus(db: Db, id: number): Promise<JobStatus | null> {
  return (await db.get<{ status: JobStatus }>("SELECT status FROM jobs WHERE id = ?", [id]))?.status ?? null;
}

export function nextQueuedItem(db: Db, jobId: number): Promise<JobItem | null> {
  return db.get<JobItem>("SELECT id, url, status, album_id, error FROM job_items WHERE job_id = ? AND status = 'queued' ORDER BY id LIMIT 1", [jobId]);
}

export async function setItemResult(db: Db, itemId: number, jobId: number, ok: boolean, albumId: number | null, error: string | null): Promise<void> {
  await db.run("UPDATE job_items SET status = ?, album_id = ?, error = ? WHERE id = ?", [ok ? "done" : "failed", albumId, error, itemId]);
  await db.run(`UPDATE jobs SET ${ok ? "done = done + 1" : "failed = failed + 1"}, updated_at = ? WHERE id = ?`, [now(), jobId]);
}

export async function resetStaleJobs(db: Db): Promise<void> {
  await db.run("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
  await db.run("UPDATE job_items SET status = 'queued' WHERE status = 'running'");
}
