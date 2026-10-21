// Resume long tracks and Radio episodes (#85). Pure rules; the player store decides when to
// save (pause, skip away, the 5 s position save, window close) and applies the saved point
// through its per-track pendingSeek. The rows live in resume_positions (migration 0010).
import { isRadioTrack } from "./radio.js";
import { clock } from "./time.js";

/** Tracks longer than this resume where they were left (DJ mixes, live sets). */
export const RESUME_MIN_TRACK_SEC = 20 * 60;
/** Positions this close to the start or the end are not worth resuming. */
export const RESUME_EDGE_SEC = 30;
/** The table keeps the most recently saved this many points. */
export const RESUME_MAX_ROWS = 200;

interface Entry { id: number; radio?: unknown; preview?: unknown; duration?: number | null }

const longer = (d: number | null | undefined) => d != null && Number.isFinite(d) && d > RESUME_MIN_TRACK_SEC;
const known = (d: number | null | undefined) => d != null && Number.isFinite(d) && d > 0;

/**
 * The one rule for reading and saving a point: a Radio episode always, a library track when
 * either its queue entry's duration or the element's (when known) is over RESUME_MIN_TRACK_SEC.
 * Never a Discover preview (#104): it isn't in the library, and its points would take rows of
 * the RESUME_MAX_ROWS cap from library tracks and episodes.
 */
export function resumeEligible(t: Entry | null | undefined, duration?: number | null): boolean {
  if (!t || t.preview) return false;
  return isRadioTrack(t) || longer(t.duration) || longer(duration);
}

/**
 * Whether to look a point up before playing: when the track is eligible, or when no duration
 * is known yet (a null queue duration may still be a long track whose point was saved).
 */
export function resumeLookupWanted(t: Entry | null | undefined, duration?: number | null): boolean {
  if (!t || t.preview) return false;
  return resumeEligible(t, duration) || (!known(t.duration) && !known(duration));
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
  return clock(Math.max(0, Math.floor(sec)));
}
