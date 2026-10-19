/**
 * Gapless playback and crossfade (#35): when to preload the next track, when to start it,
 * how the volumes ramp, and the transition's state machine. Pure so it can be tested in Node;
 * web/src/player/store.ts owns the two audio elements and applies it.
 *
 * The store keeps an "active" element (the current track: the queue index, the store's
 * status, the play counter and Now Playing all follow it) and a "standby" one that preloads
 * the next track at volume 0. At the transition point the standby starts and becomes the
 * active element; the previous one plays out its end (gapless) or fades out (crossfade) as
 * the "fading" element, then is released.
 */
import type { RepeatMode } from "../types.js";
import { positionToGain } from "./volume.js";

/** settings.key holding PlaybackSettings. */
export const PLAYBACK_SETTING_KEY = "playback";
export const CROSSFADE_MAX_SEC = 10;
/** A crossfade shorter than this (after clamping to the tracks) is played as a gapless switch. */
export const CROSSFADE_MIN_SEC = 0.5;
/**
 * Resolve the next track's stream URL and start loading it this long before the transition
 * point: enough to buffer a 128 kbps stream on a slow line, late enough that a skip or a
 * queue edit rarely wastes the fetch.
 */
export const PRELOAD_LEAD_SEC = 30;
/** Within this much of the end the store polls the playhead closely to start the next track on time. */
export const GAPLESS_ARM_SEC = 1.5;
/**
 * Start the next element this many milliseconds before the current one runs out, to cover the
 * time between play() and the first sample. 0: in WebKit (Playwright's build) a lead didn't
 * shorten the gap at all (the new element's clock started ~120 ms after the old one ended
 * whether play() came 0, 40 or 100 ms early), while in Chromium 40 ms closed it. The previous
 * element plays its last milliseconds out, so a lead overlaps rather than cuts.
 */
export const GAPLESS_START_LEAD_MS = 0;
/** How long the standby element plays muted to preroll before it counts as ready (see the store's prime()). */
export const STANDBY_PRIME_MS = 300;
/** A preloaded stream URL this close to expiry is not used; the track loads normally instead. */
export const PRELOAD_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface PlaybackSettings {
  /** Start the next track exactly when the current one ends (default on). */
  gapless: boolean;
  /** Crossfade between tracks of different albums, in seconds; 0 is off (the default). */
  crossfadeSec: number;
}

export const DEFAULT_PLAYBACK: PlaybackSettings = { gapless: true, crossfadeSec: 0 };

/** Saved or user-supplied settings, with anything missing or out of range replaced. */
export function parsePlaybackSettings(v: unknown): PlaybackSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sec = typeof o.crossfadeSec === "number" && Number.isFinite(o.crossfadeSec) ? o.crossfadeSec : DEFAULT_PLAYBACK.crossfadeSec;
  return {
    gapless: typeof o.gapless === "boolean" ? o.gapless : DEFAULT_PLAYBACK.gapless,
    crossfadeSec: Math.round(Math.min(CROSSFADE_MAX_SEC, Math.max(0, sec)) * 10) / 10,
  };
}

/**
 * The queue index that plays after `index` when the current track ends, or null when playback
 * stops there (end of queue without repeat) or restarts the same playback (repeat one).
 * Mirrors the store's next(auto).
 */
export function upcomingIndex(length: number, index: number, repeat: RepeatMode): number | null {
  if (length <= 0 || index < 0 || index >= length || repeat === "one") return null;
  if (index + 1 < length) return index + 1;
  return repeat === "all" ? 0 : null;
}

export type TransitionKind = "crossfade" | "gapless" | "plain";

const positive = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/**
 * The fade length for a transition between tracks of these durations: the setting, but at most
 * half of either track so a short track is never all fade. 0 when no crossfade applies.
 */
export function fadeSeconds(s: PlaybackSettings, curDuration: number | null | undefined, nextDuration: number | null | undefined): number {
  let sec = Math.min(CROSSFADE_MAX_SEC, Math.max(0, s.crossfadeSec));
  if (positive(curDuration)) sec = Math.min(sec, curDuration / 2);
  if (positive(nextDuration)) sec = Math.min(sec, nextDuration / 2);
  return sec >= CROSSFADE_MIN_SEC ? sec : 0;
}

/**
 * How the current track hands over to the next one. Tracks of the same album never crossfade
 * (an album's own transitions stay as recorded); they are gapless when that is on. "plain" is
 * the old behaviour: the next track loads when the current one has ended.
 */
export function transitionKind(
  cur: { album_id: number; duration?: number | null },
  next: { album_id: number; duration?: number | null },
  s: PlaybackSettings,
  curDuration?: number | null,
): TransitionKind {
  if (cur.album_id !== next.album_id && fadeSeconds(s, curDuration ?? cur.duration, next.duration) > 0) return "crossfade";
  return s.gapless ? "gapless" : "plain";
}

/** The current track's media time at which the next one starts. */
export function transitionPoint(kind: TransitionKind, duration: number, fadeSec: number): number {
  return kind === "crossfade" ? Math.max(0, duration - fadeSec) : duration;
}

/** Whether to resolve and preload the next track now. */
export function preloadDue(position: number, point: number): boolean {
  return Number.isFinite(position) && Number.isFinite(point) && point - position <= PRELOAD_LEAD_SEC;
}

/**
 * Milliseconds to wait before starting the next element for a gapless switch, given what is
 * left of the current track at `rate`. 0 means start now.
 */
export function gaplessDelayMs(remainingSec: number, rate = 1, leadMs = GAPLESS_START_LEAD_MS): number {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (!Number.isFinite(remainingSec)) return 0;
  return Math.max(0, (remainingSec * 1000) / r - leadMs);
}

/** How far into the fade (0-1) the outgoing element is, from its own playhead. */
export function fadeProgress(outPosition: number, fadeStart: number, fadeSec: number): number {
  if (!(fadeSec > 0) || !Number.isFinite(outPosition)) return 1;
  return Math.min(1, Math.max(0, (outPosition - fadeStart) / fadeSec));
}

/**
 * Both elements' gains `progress` (0-1) into a crossfade at slider position `volume`.
 *
 * The fade goes through the perceptual volume curve: each element plays at a share of the
 * slider position, and positionToGain turns that into its gain. The shares are chosen so the
 * gains follow an equal-power curve (sin/cos), keeping the summed loudness of two unrelated
 * tracks steady through the fade. A straight ramp of the slider position would dip about
 * 15 dB in the middle, because the cube curve puts half the position at -18 dB.
 */
export function crossfadeGains(progress: number, volume: number): { out: number; in: number } {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 1;
  const share = (x: number) => Math.cbrt(Math.max(0, x)); // the position share whose gain is x
  const inShare = p >= 1 ? 1 : share(Math.sin((p * Math.PI) / 2));
  const outShare = p >= 1 ? 0 : share(Math.cos((p * Math.PI) / 2));
  return { out: positionToGain(volume * outShare), in: positionToGain(volume * inShare) };
}

// ---- the transition's state machine ----

export type TransitionState =
  | { phase: "idle" }
  /** The standby element is resolving its URL (expiresAt null) or loading it. */
  | { phase: "preloading"; trackId: number; expiresAt: number | null }
  /** The standby element can start `trackId` now. */
  | { phase: "ready"; trackId: number; expiresAt: number }
  /** Preloading `trackId` failed: it loads the plain way when its turn comes. */
  | { phase: "failed"; trackId: number }
  /** The next track started; the previous element plays out (fadeSec 0) or fades out over fadeSec. */
  | { phase: "fading"; fadeStart: number; fadeSec: number };

export type TransitionEvent =
  | { type: "preload"; trackId: number }
  | { type: "resolved"; expiresAt: number }
  /** The standby element reported canplay / canplaythrough. */
  | { type: "canPlay" }
  | { type: "failed" }
  | { type: "start"; fadeStart: number; fadeSec: number }
  | { type: "fadeDone" }
  /** The queue, the index, the settings or a user action made the preload or the fade moot. */
  | { type: "invalidate" };

export const IDLE: TransitionState = { phase: "idle" };

export function transitionAfter(s: TransitionState, e: TransitionEvent): TransitionState {
  switch (e.type) {
    case "preload":
      // Only from rest: a fade in progress owns the other element.
      return s.phase === "idle" ? { phase: "preloading", trackId: e.trackId, expiresAt: null } : s;
    case "resolved":
      return s.phase === "preloading" && s.expiresAt == null ? { ...s, expiresAt: e.expiresAt } : s;
    case "canPlay":
      return s.phase === "preloading" && s.expiresAt != null ? { phase: "ready", trackId: s.trackId, expiresAt: s.expiresAt } : s;
    case "failed":
      return s.phase === "preloading" || s.phase === "ready" ? { phase: "failed", trackId: s.trackId } : s;
    case "start":
      return s.phase === "ready" ? { phase: "fading", fadeStart: e.fadeStart, fadeSec: Math.max(0, e.fadeSec) } : s;
    case "fadeDone":
      return s.phase === "fading" ? IDLE : s;
    case "invalidate":
      return IDLE;
  }
}

/** The preload no longer matches the track that plays next (the queue or the index changed). */
export function preloadStale(s: TransitionState, upcomingTrackId: number | null): boolean {
  return (s.phase === "preloading" || s.phase === "ready" || s.phase === "failed") && s.trackId !== upcomingTrackId;
}

/** The standby element can take over now for `upcomingTrackId` (ready, the right track, its URL not about to expire). */
export function standbyUsable(s: TransitionState, upcomingTrackId: number | null, now: number): boolean {
  return s.phase === "ready" && s.trackId === upcomingTrackId && s.expiresAt - now > PRELOAD_EXPIRY_MARGIN_MS;
}

// ---- which element an event came from ----

export type ElementRole = "active" | "standby" | "fading" | "idle";

/** The role of element `el` (0 or 1) when element `active` is the active one. */
export function elementRole(el: number, active: number, s: TransitionState): ElementRole {
  if (el === active) return "active";
  if (s.phase === "fading") return "fading";
  if (s.phase === "preloading" || s.phase === "ready") return "standby";
  return "idle";
}

export type ElementEventType =
  | "play" | "playing" | "pause" | "waiting" | "ended" | "error" | "canplay" | "canplaythrough" | "timeupdate"
  | "loadedmetadata" | "durationchange" | "seeking";

/**
 * What an event from an element in `role` feeds. Only the active element drives the store
 * (status, wantsPlay, position, the play counter, ended -> next track); the standby element
 * only advances the preload, and the fading one only the fade. Everything else is ignored, so
 * a preload or a fade-out never changes what the player shows.
 */
export function routeElementEvent(role: ElementRole, type: ElementEventType): "store" | TransitionEvent["type"] | "fadeTick" | null {
  switch (role) {
    case "active":
      return "store";
    case "standby":
      if (type === "loadedmetadata" || type === "canplay" || type === "canplaythrough") return "canPlay";
      if (type === "error") return "failed";
      return null;
    case "fading":
      if (type === "ended" || type === "error") return "fadeDone";
      if (type === "timeupdate") return "fadeTick";
      return null;
    case "idle":
      return null;
  }
}
