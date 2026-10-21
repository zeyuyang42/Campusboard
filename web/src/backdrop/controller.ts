// The backdrop's rules (#110), pure so they are tested without a canvas: which state the
// morph renderer is in, how often it may draw, and a clock that only advances while drifting
// (so a pause freezes the picture and a resume continues from the same phase).
import type { Backdrop } from "@bc/core";

/**
 * off: no canvas work (the mode isn't morph). css: morph is wanted but WebGL failed, the CSS
 * wash shows instead. gl-frozen: the canvas keeps its last frame (paused, still, hidden,
 * Reduce motion). gl-fading: a track change cross-fades the colours for FADE_MS, even while
 * frozen. gl-drift: the picture moves.
 */
export type BackdropState = "off" | "css" | "gl-frozen" | "gl-fading" | "gl-drift";

export interface ControllerInput {
  mode: Backdrop["mode"];
  motion: Backdrop["motion"];
  /** The player's status; anything but "playing" freezes the drift. */
  status: string;
  hidden: boolean;
  reducedMotion: boolean;
  glOk: boolean;
  fading: boolean;
}

export function backdropState(i: ControllerInput): BackdropState {
  if (i.mode !== "morph") return "off";
  if (!i.glOk) return "css";
  if (i.hidden) return "gl-frozen";
  if (i.fading) return "gl-fading";
  if (i.reducedMotion || i.motion === "still" || i.status !== "playing") return "gl-frozen";
  return "gl-drift";
}

/** A track change cross-fades the two palettes over this long. */
export const FADE_MS = 2000;

/**
 * Frames per second per style. Every style drifts at 30 since #113 (the 4 fps film-like cap
 * belonged to the grain gradient, which the glitch style replaced); the function stays so a
 * future style can cap itself here, the one lever for CPU besides the buffer size.
 */
export function fps(_style: Backdrop["style"]): number {
  return 30;
}

/** 0..1 eased progress of a fade that started at `startedAt`. */
export function fadeMix(startedAt: number, now: number): number {
  const t = Math.min(1, Math.max(0, (now - startedAt) / FADE_MS));
  return t * t * (3 - 2 * t);
}

/**
 * Lets a frame through at most `fps` times a second. requestAnimationFrame ticks at the
 * display rate (16.7 ms at 60 Hz), so the interval has a 4 ms tolerance: two ticks are 33.3 ms,
 * which must count as a 30 fps frame.
 */
export class FrameGate {
  private last = -Infinity;
  constructor(public fps: number) {}
  due(now: number): boolean {
    if (now - this.last < 1000 / this.fps - 4) return false;
    this.last = now;
    return true;
  }
  reset() { this.last = -Infinity; }
}

/**
 * The shader clock in seconds. It accumulates only between two drifting ticks, so a freeze
 * keeps the phase and the first frame after a resume adds nothing; a single step is capped so
 * a stalled frame (a long task, a sleeping Mac) never jumps the picture.
 */
export class DriftClock {
  time = 0;
  private lastNow: number | null = null;
  private wasDrifting = false;
  static readonly MAX_STEP_S = 0.25;
  tick(now: number, drifting: boolean): number {
    if (this.lastNow != null && drifting && this.wasDrifting) this.time += Math.min(DriftClock.MAX_STEP_S, Math.max(0, now - this.lastNow) / 1000);
    this.lastNow = now;
    this.wasDrifting = drifting;
    return this.time;
  }
}

/** The render buffer for a window of `w`×`h` CSS pixels: half size, DPR ignored, capped at 960×540. */
export const BUFFER_MAX: readonly [number, number] = [960, 540];
export function bufferSize(w: number, h: number): [number, number] {
  return [Math.max(1, Math.min(BUFFER_MAX[0], Math.ceil(w / 2))), Math.max(1, Math.min(BUFFER_MAX[1], Math.ceil(h / 2)))];
}
