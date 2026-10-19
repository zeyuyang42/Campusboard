import type { Db } from "../Db.js";
import { now } from "../Db.js";
import type { Job, JobItem, JobKind, JobStatus } from "../../types.js";

/**
 * Create a job with its items. The job is inserted as "pending", which the runner never
 * picks up, and flipped to "queued" only once its items exist, so a runner pass between
 * the statements can't see a job with no items. The flip is conditional, so a cancel that
 * lands in between wins. A crash in between is repaired by resetStaleJobs().
 */
export async function createJob(db: Db, kind: JobKind, inputUrl: string, itemUrls: string[]): Promise<Job> {
  const r = await db.get<{ id: number }>("INSERT INTO jobs (kind, input_url, total, status) VALUES (?, ?, ?, 'pending') RETURNING id", [kind, inputUrl, itemUrls.length]);
  if (itemUrls.length) await addJobItems(db, r!.id, itemUrls);
  await transitionJob(db, r!.id, ["pending"], "queued");
  return (await getJob(db, r!.id, false))!;
}

export async function addJobItems(db: Db, jobId: number, urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i += 200) {
    const chunk = urls.slice(i, i + 200);
    await db.run(`INSERT INTO job_items (job_id, url) VALUES ${chunk.map(() => "(?, ?)").join(",")}`, chunk.flatMap((u) => [jobId, u]));
  }
  await db.run("UPDATE jobs SET total = (SELECT COUNT(*) FROM job_items WHERE job_id = ?), updated_at = ? WHERE id = ?", [jobId, now(), jobId]);
}

/** Jobs still being created ("pending") are left out until they are queued. */
export function listJobs(db: Db, limit = 50): Promise<Job[]> {
  return db.select<Job>("SELECT * FROM jobs WHERE status != 'pending' ORDER BY id DESC LIMIT ?", [limit]);
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

/**
 * Move a job to `to` only if it is currently one of `from`, in one statement, so a
 * concurrent cancel can't be overwritten. True if the job moved.
 */
export async function transitionJob(db: Db, id: number, from: JobStatus[], to: JobStatus, error: string | null = null): Promise<boolean> {
  const r = await db.get<{ id: number }>(
    `UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")}) RETURNING id`,
    [to, error, now(), id, ...from],
  );
  return !!r;
}

/** Fail every item still queued with one reason, then recount. Each step is idempotent. */
export async function failQueuedItems(db: Db, jobId: number, error: string): Promise<void> {
  await db.run("UPDATE job_items SET status = 'failed', error = ? WHERE job_id = ? AND status = 'queued'", [error, jobId]);
  await db.run("UPDATE jobs SET failed = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'failed'), updated_at = ? WHERE id = ?", [jobId, now(), jobId]);
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

/** Cancel every pending, queued or running job of one kind, in one statement. True if any was. */
export async function cancelJobsOfKind(db: Db, kind: JobKind): Promise<boolean> {
  const r = await db.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE kind = ? AND status IN ('pending','queued','running')", [now(), kind]);
  return r.changes > 0;
}

/**
 * On startup: re-queue what was running, and settle jobs left "pending" by a crash inside
 * createJob(). One with items is queued with its total recounted (the items may have been
 * cut short between chunks); one created without items on purpose (discography, collection:
 * total 0) is queued as is; one whose items never landed is removed. Each step is idempotent.
 */
export async function resetStaleJobs(db: Db): Promise<void> {
  await db.run("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
  await db.run("UPDATE job_items SET status = 'queued' WHERE status = 'running'");
  await db.run(
    `UPDATE jobs SET status = 'queued', total = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id), updated_at = ?
     WHERE status = 'pending' AND (total = 0 OR EXISTS (SELECT 1 FROM job_items WHERE job_id = jobs.id))`,
    [now()],
  );
  await db.run("DELETE FROM jobs WHERE status = 'pending'");
}
