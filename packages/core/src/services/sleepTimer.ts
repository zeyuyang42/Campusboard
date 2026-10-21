// The sleep timer (#70): stop playback after a while or at a natural break. Pure rules; the
// player store owns the timer, the audio elements and the fade. Not persisted.
import { positionToGain } from "./volume.js";
import { clock } from "./time.js";

/** What the listener picked: minutes from now, the end of the current track, or of its album. */
export type SleepChoice = "off" | 15 | 30 | 45 | 60 | "track" | "album";
export type SleepTimer = { kind: "minutes"; minutes: number; endsAt: number } | { kind: "track" } | { kind: "album" };

export const SLEEP_MINUTES = [15, 30, 45, 60] as const;
/** The fade before the pause, in seconds. */
export const SLEEP_FADE_SEC = 10;

export function sleepTimerFor(choice: SleepChoice, now: number): SleepTimer | null {
  if (choice === "off") return null;
  if (choice === "track" || choice === "album") return { kind: choice };
  return { kind: "minutes", minutes: choice, endsAt: now + choice * 60_000 };
}

export const sleepChoiceOf = (t: SleepTimer | null): SleepChoice => (t ? (t.kind === "minutes" ? (t.minutes as SleepChoice) : t.kind) : "off");

interface Entry { album_id: number }
/**
 * Whether playback stops when the current track ends: always for "end of track", and for
 * "end of album" when no track follows, the next one is from another album (a radio episode
 * is its own album), or the queue wraps round (repeat-all: `wraps`, the next track is at or
 * before this one), which is the end of the album even when the queue holds only that album.
 * Never for the minutes timer, which stops at its time.
 */
export function sleepStopsAtEnd(t: SleepTimer | null, current: Entry | null, upcoming: Entry | null, wraps = false): boolean {
  if (!t || !current || t.kind === "minutes") return false;
  return t.kind === "track" || !upcoming || wraps || upcoming.album_id !== current.album_id;
}

/**
 * Seconds until the stop: to the timer's time, or to the end of a track that is the stopping
 * point (Infinity while its duration is unknown, or when this track isn't the stop).
 */
export function sleepSecondsLeft(t: SleepTimer, now: number, stopsAtEnd: boolean, el: { currentTime: number; duration: number }): number {
  if (t.kind === "minutes") return (t.endsAt - now) / 1000;
  if (!stopsAtEnd || !Number.isFinite(el.duration) || el.duration <= 0) return Infinity;
  return Math.max(0, el.duration - el.currentTime);
}

/** The share of the slider position the fade leaves: 1 until the last SLEEP_FADE_SEC, then down to 0. */
export function sleepScale(secondsLeft: number): number {
  if (!(secondsLeft < SLEEP_FADE_SEC)) return 1;
  return Math.max(0, secondsLeft) / SLEEP_FADE_SEC;
}

/** The element gain for a slider position under the fade: through the perceptual curve (#36). */
export const sleepGain = (volume: number, scale: number) => positionToGain(volume * scale);

/** The quiet countdown in the player bar: m:ss for the minutes timer (a full hour reads "60:00"). */
export function formatSleepLeft(sec: number): string {
  return clock(Math.max(0, Math.ceil(sec)), false);
}
