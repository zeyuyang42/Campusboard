/**
 * When a playback counts as a play (the scrobbler rule): once the time actually listened
 * reaches half the track or four minutes, whichever comes first, and only for tracks longer
 * than 30 seconds. Listened time is measured from playhead progress, so seeking ahead never
 * counts, pausing just stops the clock, and each fresh playback (a new load, repeat-one,
 * restarting with Previous or by seeking back to the start, playing again after the end)
 * can count once.
 */
export const PLAY_MIN_TRACK_SEC = 30;
export const PLAY_MAX_THRESHOLD_SEC = 240;
/**
 * Slack, in seconds of media, when comparing a playhead step with the wall-clock time that
 * passed. Covers timer jitter and a rate change between two reports.
 */
export const PLAY_STEP_TOLERANCE_SEC = 1.5;
/** Seeking back to before this point after the play has counted starts a fresh playback. */
export const PLAY_RESTART_SEC = 2;

/** Seconds of listening a track needs before it counts, or null if it can never count. */
export function playThreshold(duration: number | null | undefined): number | null {
  if (duration == null || !Number.isFinite(duration) || duration <= PLAY_MIN_TRACK_SEC) return null;
  return Math.min(duration / 2, PLAY_MAX_THRESHOLD_SEC);
}

export interface CountedPlay {
  trackId: number;
  /**
   * Seconds listened when the play counted, to a tenth of a second: the threshold plus at most
   * one report's step. Listening after that point is not added.
   */
  seconds: number;
}

/** Follows one playback at a time and reports the moment it counts. */
export class PlayCounter {
  private id: number | null = null;
  private duration: number | null = null;
  private listened = 0;
  private last: { t: number; wallMs: number } | null = null;
  private counted = false;

  /** The track of the current playback, or null before the first one. */
  get trackId(): number | null { return this.id; }
  get listenedSeconds(): number { return this.listened; }

  /** A fresh playback of `trackId` begins: listened time starts again from zero. */
  start(trackId: number, duration?: number | null): void {
    this.id = trackId;
    this.duration = duration ?? null;
    this.listened = 0;
    this.last = null;
    this.counted = false;
  }

  /** The real duration, once the media element knows it (preferred over the library's). */
  setDuration(duration: number): void {
    if (Number.isFinite(duration) && duration > 0) this.duration = duration;
  }

  /**
   * The playhead jumped (a seek) to `to` seconds, if known: the next progress report only sets
   * a new baseline. Going back to the very start after the play counted is a manual restart,
   * which is a fresh playback.
   */
  seeked(to?: number): void {
    this.last = null;
    if (this.counted && this.id != null && to != null && to < PLAY_RESTART_SEC) this.start(this.id, this.duration);
  }

  /**
   * The playhead is at `t` seconds at wall-clock `wallMs` (any monotonic millisecond clock),
   * playing at `rate`. Returns the play the first time this playback counts.
   *
   * A step counts if it is no more than the wall-clock time since the last report allows at
   * this rate (plus a little slack). Reports can be far apart when the window is hidden or
   * the app is napping, and those steps still count; a step bigger than the elapsed time
   * allows is a seek the caller didn't announce.
   */
  progress(t: number, wallMs: number, rate = 1): CountedPlay | null {
    if (!Number.isFinite(t) || !Number.isFinite(wallMs)) return null;
    const prev = this.last;
    this.last = { t, wallMs };
    if (this.id == null || this.counted || prev == null) return null;
    const step = t - prev.t;
    const allowed = (Math.max(0, wallMs - prev.wallMs) / 1000) * Math.max(0, Number.isFinite(rate) ? rate : 1) + PLAY_STEP_TOLERANCE_SEC;
    if (step > 0 && step <= allowed) this.listened += step;
    const threshold = playThreshold(this.duration);
    if (threshold == null || this.listened < threshold) return null;
    this.counted = true;
    return { trackId: this.id, seconds: Math.round(this.listened * 10) / 10 };
  }
}
