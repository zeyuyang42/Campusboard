import type { Db } from "../db/Db.js";
import type { ChallengeGate } from "../scrape/challenge.js";
import { ACTIVE_SQL } from "../db/repos/jobs.js";

/**
 * Why background Bandcamp work (new-release checks, the collection refresh) should wait right
 * now: a challenge cooldown runs, or an import or sync job is pending, queued or running.
 * Null when the app is idle.
 */
export async function idleBlock(db: Db, gate: ChallengeGate): Promise<"cooldown" | "job" | null> {
  await gate.ready();
  if (gate.until()) return "cooldown";
  if (await db.get(`SELECT 1 FROM jobs WHERE ${ACTIVE_SQL} LIMIT 1`)) return "job";
  return null;
}
