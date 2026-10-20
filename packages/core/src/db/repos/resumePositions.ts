import type { Db } from "../Db.js";
import { RESUME_MAX_ROWS } from "../../services/resume.js";

/**
 * Resume points (#85, table resume_positions, migration 0010), keyed by the queue entry's id
 * (negative for a Radio episode). Personal playback state like play_state, so not part of the
 * library export. The save is one idempotent upsert and the cap a second statement: an
 * interruption between them leaves one row over the cap until the next save.
 */
export async function getResumePosition(db: Db, itemId: number): Promise<number | null> {
  const r = await db.get<{ position_sec: number }>("SELECT position_sec FROM resume_positions WHERE item_id = ?", [itemId]);
  return r ? r.position_sec : null;
}

export async function setResumePosition(db: Db, itemId: number, positionSec: number, savedAt = Date.now()): Promise<void> {
  if (!Number.isFinite(positionSec) || positionSec < 0) return;
  await db.run(
    `INSERT INTO resume_positions (item_id, position_sec, saved_at) VALUES (?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET position_sec = excluded.position_sec, saved_at = excluded.saved_at`,
    [itemId, positionSec, savedAt],
  );
  await db.run(
    "DELETE FROM resume_positions WHERE item_id NOT IN (SELECT item_id FROM resume_positions ORDER BY saved_at DESC, item_id DESC LIMIT ?)",
    [RESUME_MAX_ROWS],
  );
}

export async function clearResumePosition(db: Db, itemId: number): Promise<void> {
  await db.run("DELETE FROM resume_positions WHERE item_id = ?", [itemId]);
}
