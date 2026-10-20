// Resume long tracks and Radio episodes (#85). Pure rules; the player store decides when to
// save (pause, skip away, the 5 s position save, window close) and applies the saved point
// through its per-track pendingSeek. The rows live in resume_positions (migration 0010).
import { isRadioTrack } from "./radio.js";

/** Tracks longer than this resume where they were left (DJ mixes, live sets). */
export const RESUME_MIN_TRACK_SEC = 20 * 60;
/** Positions this close to the start or the end are not worth resuming. */
export const RESUME_EDGE_SEC = 30;
/** The table keeps the most recently saved this many points. */
export const RESUME_MAX_ROWS = 200;

interface Entry { id: number; radio?: unknown; duration?: number | null }

/**
 * A Radio episode always resumes; a library track when it is over RESUME_MIN_TRACK_SEC (the
 * element's duration when known, else the queue entry's).
 */
export function resumeEligible(t: Entry | null | undefined, duration?: number): boolean {
  if (!t) return false;
  if (isRadioTrack(t)) return true;
  const d = duration != null && Number.isFinite(duration) && duration > 0 ? duration : t.duration ?? 0;
  return d > RESUME_MIN_TRACK_SEC;
}

/**
 * The point to keep for a playhead at `position`, or null to forget any saved one: under
 * RESUME_EDGE_SEC from the start, or within it of the end (when the duration is known).
 */
export function resumePoint(position: number, duration: number): number | null {
  if (!Number.isFinite(position) || position < RESUME_EDGE_SEC) return null;
  if (Number.isFinite(duration) && duration > 0 && duration - position <= RESUME_EDGE_SEC) return null;
  return position;
}

/** "41:20", or "1:02:05" past an hour, for the player bar's hint. */
export function formatResumeAt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
