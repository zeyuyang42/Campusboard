/**
 * When a playback counts as a play (the scrobbler rule): once the time actually listened
 * reaches half the track or four minutes, whichever comes first, and only for tracks longer
 * than 30 seconds. Listened time is measured from playhead progress, so seeking ahead never
 * counts, pausing just stops the clock, and each fresh playback (a new load, repeat-one,
 * restarting with Previous, playing again after the end) can count once.
 */
export const PLAY_MIN_TRACK_SEC = 30;
export const PLAY_MAX_THRESHOLD_SEC = 240;
/**
 * The largest playhead step between two progress reports that still counts as listening.
 * Reports arrive every quarter second or so, even at high playback rates; a bigger jump is a
 * seek the caller didn't announce.
 */
export const PLAY_MAX_STEP_SEC = 10;

/** Seconds of listening a track needs before it counts, or null if it can never count. */
export function playThreshold(duration: number | null | undefined): number | null {
  if (duration == null || !Number.isFinite(duration) || duration <= PLAY_MIN_TRACK_SEC) return null;
  return Math.min(duration / 2, PLAY_MAX_THRESHOLD_SEC);
}

export interface CountedPlay {
  trackId: number;
  /** Seconds listened when the play counted, to a tenth of a second. */
  seconds: number;
}

/** Follows one playback at a time and reports the moment it counts. */
export class PlayCounter {
  private id: number | null = null;
  private duration: number | null = null;
  private listened = 0;
  private last: number | null = null;
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

  /** The playhead jumped (a seek): the next progress report only sets a new baseline. */
  seeked(): void {
    this.last = null;
  }

  /** The playhead is at `t` seconds. Returns the play the first time this playback counts. */
  progress(t: number): CountedPlay | null {
    if (!Number.isFinite(t)) return null;
    const prev = this.last;
    this.last = t;
    if (this.id == null || this.counted || prev == null) return null;
    const step = t - prev;
    if (step > 0 && step <= PLAY_MAX_STEP_SEC) this.listened += step;
    const threshold = playThreshold(this.duration);
    if (threshold == null || this.listened < threshold) return null;
    this.counted = true;
    return { trackId: this.id, seconds: Math.round(this.listened * 10) / 10 };
  }
}
