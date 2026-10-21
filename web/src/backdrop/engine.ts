// The morph backdrop's loop (#110), without React or a real canvas: the GL layer, the clock
// and the scheduler are injected, so web/test/backdrop.test.ts drives it with a stub. One
// instance lives for the window (Backdrop.tsx); `window.__bcBackdrop` exposes its state and
// frame count for Playwright and the selftest.
import { color, type Backdrop, type BoostedPalette } from "@bc/core";
import { backdropState, bufferSize, DriftClock, fadeMix, FADE_MS, fps, FrameGate, type BackdropState } from "./controller";
import { SWATCH_SLOTS } from "./shaders";
import type { GlFactory, GlLike, GlUniforms } from "./gl";

export interface EngineInput {
  mode: Backdrop["mode"];
  style: Backdrop["style"];
  intensity: number;
  motion: Backdrop["motion"];
  status: string;
  hidden: boolean;
  reducedMotion: boolean;
  /** The theme surface, hex. */
  surface: string;
  dark: boolean;
}

export interface EngineDeps {
  createGl: GlFactory;
  now: () => number;
  schedule: (cb: () => void) => unknown;
  cancel: (id: unknown) => void;
}

interface Slots { col: Float32Array; w: Float32Array }

/** A palette as uniform slots: colours in 0..1, weights summing to 1, empty slots at weight 0. */
export function paletteSlots(p: BoostedPalette | null, surface: string): Slots {
  const col = new Float32Array(SWATCH_SLOTS * 3);
  const w = new Float32Array(SWATCH_SLOTS);
  const list = p?.swatches.length ? p.swatches : [{ hex: surface, weight: 1 }];
  const total = list.reduce((n, s) => n + s.weight, 0) || 1;
  list.slice(0, SWATCH_SLOTS).forEach((s, i) => {
    const { r, g, b } = color.hexToRgb(s.hex);
    col[i * 3] = r / 255; col[i * 3 + 1] = g / 255; col[i * 3 + 2] = b / 255;
    w[i] = s.weight / total;
  });
  return { col, w };
}

const rgb01 = (hex: string): [number, number, number] => {
  const { r, g, b } = color.hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
};

export class BackdropEngine {
  frames = 0;
  state: BackdropState = "off";
  input: EngineInput = { mode: "conservative", style: "ink", intensity: 0.7, motion: "drift", status: "idle", hidden: false, reducedMotion: false, surface: "#23262D", dark: true };

  private canvas: HTMLCanvasElement | null = null;
  private gl: GlLike | null = null;
  private glOk = true;
  private palA: BoostedPalette | null = null;
  private palB: BoostedPalette | null = null;
  private seedA = 0;
  private seedB = 0;
  private fadeStart: number | null = null;
  private dirty = true;
  private pending: unknown = null;
  private readonly gate = new FrameGate(30);
  private readonly clock = new DriftClock();
  private readonly listeners = new Set<(s: BackdropState) => void>();
  private size: [number, number] = [1, 1];

  constructor(private readonly deps: EngineDeps) {}

  onChange(fn: (s: BackdropState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Give the engine its canvas (mounted) or take it away (unmounted). */
  attach(canvas: HTMLCanvasElement | null) {
    if (this.canvas === canvas) return;
    this.gl?.dispose();
    this.gl = null;
    this.canvas = canvas;
    this.glOk = true;
    if (canvas) {
      this.gl = this.deps.createGl(canvas, { onLost: () => this.setGlOk(false), onRestored: () => this.setGlOk(true), onFailed: () => this.setGlOk(false) });
      if (!this.gl) this.glOk = false;
      else { this.gl.setStyle(this.input.style); this.gl.resize(this.size[0], this.size[1]); }
    }
    this.gate.reset();
    this.dirty = true;
    this.kick();
  }

  /** The window's CSS size; the buffer is half of it, capped (controller.bufferSize). */
  resize(cssWidth: number, cssHeight: number) {
    this.size = bufferSize(cssWidth, cssHeight);
    this.gl?.resize(this.size[0], this.size[1]);
    this.dirty = true;
    this.kick();
  }

  setInput(patch: Partial<EngineInput>) {
    const next = { ...this.input, ...patch };
    const changed = (Object.keys(next) as (keyof EngineInput)[]).some((k) => next[k] !== this.input[k]);
    if (!changed) return;
    if (next.style !== this.input.style) { this.gl?.setStyle(next.style); this.gate.fps = fps(next.style); this.gate.reset(); }
    this.input = next;
    this.dirty = true;
    this.kick();
  }

  /**
   * New art: the first palette paints at once, a later one cross-fades from the one on
   * screen over FADE_MS (also while frozen). `seed` offsets the pattern per image.
   */
  setSwatches(p: BoostedPalette | null, seed = 0) {
    const now = this.deps.now();
    // The palette already on screen (or arriving): a remount re-publishes it, no fade then.
    const shown = this.fadeStart !== null ? this.palB : this.palA;
    const shownSeed = this.fadeStart !== null ? this.seedB : this.seedA;
    if (p === shown && seed === shownSeed) return;
    if (this.palA === null && this.fadeStart === null) {
      this.palA = p; this.seedA = seed;
    } else {
      // A fade still running jumps to its end before the next one starts.
      if (this.fadeStart !== null) { this.palA = this.palB; this.seedA = this.seedB; }
      this.palB = p; this.seedB = seed;
      this.fadeStart = now;
    }
    this.dirty = true;
    this.kick();
  }

  /** The shader clock in seconds (window.__bcBackdrop.time). */
  get time(): number { return this.clock.time; }

  /** Debug: jump the shader clock (window.__bcBackdrop.setTime), so Playwright can land on a glitch burst. */
  setTime(seconds: number) {
    this.clock.time = Math.max(0, seconds);
    this.dirty = true;
    this.kick();
  }

  dispose() {
    if (this.pending !== null) { this.deps.cancel(this.pending); this.pending = null; }
    this.attach(null);
    this.listeners.clear();
  }

  private setGlOk(ok: boolean) {
    this.glOk = ok;
    this.dirty = true;
    this.gate.reset();
    this.kick();
  }

  private kick() {
    if (this.pending !== null) return;
    this.pending = this.deps.schedule(this.tick);
  }

  private readonly tick = () => {
    this.pending = null;
    this.update(this.deps.now());
  };

  private update(now: number) {
    let fading = this.fadeStart !== null;
    if (fading && now - (this.fadeStart as number) >= FADE_MS) {
      this.palA = this.palB; this.seedA = this.seedB; this.palB = null; this.fadeStart = null;
      fading = false;
      this.dirty = true; // the settled frame, drawn at mix 0
    }
    const i = this.input;
    const base = { mode: i.mode, motion: i.motion, status: i.status, hidden: i.hidden, reducedMotion: i.reducedMotion, glOk: this.glOk && this.gl !== null };
    const state = backdropState({ ...base, fading });
    const drifting = backdropState({ ...base, fading: false }) === "gl-drift";
    if (state !== this.state) { this.state = state; this.listeners.forEach((fn) => fn(state)); }
    if (state === "off" || state === "css") { this.dirty = false; return; }
    const running = state === "gl-drift" || state === "gl-fading";
    if (running) {
      if (this.gate.due(now)) this.render(now, drifting, fading);
      this.kick();
    } else if (this.dirty) {
      this.render(now, false, false);
    }
  }

  private render(now: number, drifting: boolean, fading: boolean) {
    if (!this.gl) return;
    const i = this.input;
    const a = paletteSlots(this.palA, i.surface);
    const b = paletteSlots(fading ? this.palB : this.palA, i.surface);
    const u: GlUniforms = {
      time: this.clock.tick(now, drifting),
      mix: fading && this.fadeStart !== null ? fadeMix(this.fadeStart, now) : 0,
      intensity: i.intensity,
      surface: rgb01(i.surface),
      colA: a.col, wA: a.w, colB: b.col, wB: b.w,
      seed: fading && this.fadeStart !== null ? this.seedA + (this.seedB - this.seedA) * fadeMix(this.fadeStart, now) : this.seedA,
      dark: i.dark,
      // A frozen frame must not be caught mid-burst (glitch), so the shader learns it is one.
      still: !drifting,
    };
    // Only a frame that reached the canvas counts (a lost context or a failed program draws nothing).
    if (this.gl.render(u)) this.frames++;
    this.dirty = false;
  }
}

/** A seed per image: the same art always gets the same pattern, different art a different one. */
export function seedFor(artKey: number | null): number {
  if (!artKey) return 0;
  return (Math.abs(artKey) % 997) / 997 * 50;
}
