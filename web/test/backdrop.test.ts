import { describe, it, expect, vi } from "vitest";
import type { BoostedPalette } from "@bc/core";
import { BackdropEngine, paletteSlots, seedFor } from "../src/backdrop/engine";
import { backdropState, bufferSize, DriftClock, fadeMix, FADE_MS, fps, FrameGate } from "../src/backdrop/controller";
import type { GlHooks, GlUniforms } from "../src/backdrop/gl";

// happy-dom has no WebGL: the GL layer is a stub that records what it was asked to draw, and
// the scheduler is a hand-cranked 60 Hz requestAnimationFrame.
function makeEngine() {
  let now = 0;
  let queue: (() => void)[] = [];
  const renders: GlUniforms[] = [];
  let hooks: GlHooks | null = null;
  let draws = true;
  const gl = {
    setStyle: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
    render: vi.fn((u: GlUniforms) => { renders.push({ ...u }); return draws; }),
  };
  let glAvailable = true;
  const createGl = vi.fn((_c: HTMLCanvasElement, h: GlHooks) => { hooks = h; return glAvailable ? gl : null; });
  const engine = new BackdropEngine({
    createGl,
    now: () => now,
    schedule: (cb) => { queue.push(cb); return cb; },
    cancel: (id) => { queue = queue.filter((cb) => cb !== id); },
  });
  const canvas = document.createElement("canvas");
  /** Advance `ms` of wall clock in 60 Hz steps, running whatever frames were scheduled. */
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end - 1e-9) {
      now = Math.min(end, now + 1000 / 60);
      const cbs = queue.splice(0);
      cbs.forEach((cb) => cb());
    }
  };
  const states: string[] = [];
  engine.onChange((s) => states.push(s));
  return {
    engine, gl, renders, run, canvas, states, createGl,
    hooks: () => hooks!, setGlAvailable: (v: boolean) => { glAvailable = v; }, setDraws: (v: boolean) => { draws = v; },
    frames: () => engine.frames,
    time: () => renders.at(-1)?.time ?? 0,
  };
}

const pal = (hex: string): BoostedPalette => ({ swatches: [{ hex, weight: 0.6, L: 0.5, C: 0.15, h: 20 }, { hex: "#223344", weight: 0.4, L: 0.4, C: 0.1, h: 250 }], neutral: false });
const morph = { mode: "morph", style: "ink", intensity: 0.7, motion: "drift", surface: "#23262D", dark: true, hidden: false, reducedMotion: false } as const;

describe("backdropState (pure)", () => {
  const base = { mode: "morph", motion: "drift", status: "playing", hidden: false, reducedMotion: false, glOk: true, fading: false } as const;
  it("picks the state in priority order", () => {
    expect(backdropState(base)).toBe("gl-drift");
    expect(backdropState({ ...base, mode: "wash" })).toBe("off");
    expect(backdropState({ ...base, mode: "conservative", glOk: false })).toBe("off");
    expect(backdropState({ ...base, glOk: false })).toBe("css");
    expect(backdropState({ ...base, hidden: true, fading: true })).toBe("gl-frozen");
    expect(backdropState({ ...base, status: "paused", fading: true })).toBe("gl-fading");
    expect(backdropState({ ...base, status: "paused" })).toBe("gl-frozen");
    expect(backdropState({ ...base, reducedMotion: true })).toBe("gl-frozen");
    expect(backdropState({ ...base, motion: "still" })).toBe("gl-frozen");
    expect(backdropState({ ...base, status: "loading" })).toBe("gl-frozen");
  });
  it("fps, fade curve, frame gate, drift clock and buffer size", () => {
    // Every style is capped at 30 since #113 (the glitch style replaced the 4 fps grain gradient).
    for (const s of ["ink", "aurora", "glitch", "lava"] as const) expect(fps(s)).toBe(30);
    expect(fadeMix(0, 0)).toBe(0);
    expect(fadeMix(0, FADE_MS / 2)).toBeCloseTo(0.5);
    expect(fadeMix(0, FADE_MS * 2)).toBe(1);
    const gate = new FrameGate(30);
    let passed = 0;
    for (let tick = 0; tick < 60; tick++) if (gate.due((tick * 1000) / 60)) passed++;
    expect(passed).toBe(30);
    const clock = new DriftClock();
    clock.tick(0, true); clock.tick(100, true); clock.tick(2000, false); clock.tick(5000, false);
    expect(clock.time).toBeCloseTo(0.1);
    // The first drifting tick after a freeze adds nothing (the gap was the pause), the next one does.
    clock.tick(5500, true);
    expect(clock.time).toBeCloseTo(0.1);
    clock.tick(5533, true);
    expect(clock.time).toBeCloseTo(0.133, 2);
    // A stalled frame is capped.
    clock.tick(9000, true);
    expect(clock.time).toBeCloseTo(0.133 + DriftClock.MAX_STEP_S, 2);
    expect(bufferSize(1200, 800)).toEqual([600, 400]);
    expect(bufferSize(3000, 2000)).toEqual([960, 540]);
    expect(bufferSize(0, 0)).toEqual([1, 1]);
  });
  it("paletteSlots pads to six, normalises weights and falls back to the surface", () => {
    const s = paletteSlots(pal("#ff0000"), "#23262D");
    expect(s.col.length).toBe(18);
    expect(Array.from(s.w).map((w) => Math.round(w * 100) / 100)).toEqual([0.6, 0.4, 0, 0, 0, 0]);
    expect(s.col[0]).toBe(1);
    const none = paletteSlots(null, "#000000");
    expect(Array.from(none.w)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(seedFor(null)).toBe(0);
    expect(seedFor(5)).toBe(seedFor(5));
    expect(seedFor(5)).not.toBe(seedFor(6));
    expect(seedFor(-5)).toBe(seedFor(5));
  });
});

describe("BackdropEngine", () => {
  it("renders about 30 frames a second while playing, and the clock advances", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(1000);
    expect(h.engine.state).toBe("gl-drift");
    expect(h.frames()).toBeGreaterThanOrEqual(29);
    expect(h.frames()).toBeLessThanOrEqual(32);
    expect(h.time()).toBeGreaterThan(0.9);
    expect(h.gl.setStyle).toHaveBeenCalledWith("ink");
  });

  it("paused: one still frame, then no frames; the clock keeps its phase across the pause", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(1000);
    const t1 = h.time();
    h.engine.setInput({ status: "paused" });
    h.run(50);
    expect(h.engine.state).toBe("gl-frozen");
    const settled = h.frames();
    h.run(5000);
    expect(h.frames()).toBe(settled);
    expect(h.time()).toBeCloseTo(t1, 1);
    h.engine.setInput({ status: "playing" });
    h.run(1000);
    expect(h.engine.state).toBe("gl-drift");
    // Roughly a second more of shader time, not six: the pause didn't count.
    expect(h.time() - t1).toBeGreaterThan(0.8);
    expect(h.time() - t1).toBeLessThan(1.3);
  });

  it("hidden and Reduce motion freeze the drift", () => {
    for (const patch of [{ hidden: true }, { reducedMotion: true }, { motion: "still" as const }]) {
      const h = makeEngine();
      h.engine.setInput({ ...morph, status: "playing", ...patch });
      h.engine.attach(h.canvas);
      h.engine.setSwatches(pal("#ff0000"), 1);
      h.run(100);
      expect(h.engine.state).toBe("gl-frozen");
      const n = h.frames();
      expect(n).toBeLessThanOrEqual(2);
      h.run(3000);
      expect(h.frames()).toBe(n);
    }
  });

  it("a track change cross-fades for 2 s even while paused or under Reduce motion, then stops", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "paused", reducedMotion: true });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(100);
    const before = h.frames();
    h.engine.setSwatches(pal("#00ff00"), 2);
    h.run(1000);
    expect(h.engine.state).toBe("gl-fading");
    const mid = h.renders.at(-1)!;
    expect(mid.mix).toBeGreaterThan(0.3);
    expect(mid.mix).toBeLessThan(0.7);
    expect(mid.colA[0]).toBe(1); // red on the A side
    expect(mid.colB[1]).toBe(1); // green on the B side
    expect(h.frames() - before).toBeGreaterThanOrEqual(28);
    h.run(1100);
    expect(h.engine.state).toBe("gl-frozen");
    const last = h.renders.at(-1)!;
    expect(last.mix).toBe(0);
    expect(last.colA[1]).toBe(1); // green is now the resting palette
    const settled = h.frames();
    h.run(3000);
    expect(h.frames()).toBe(settled);
    expect(h.states).toContain("gl-fading");
  });

  it("the glitch style draws at 30 fps like the others, and a style switch asks GL for the new program", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, style: "glitch", status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(1000);
    expect(h.frames()).toBeGreaterThanOrEqual(29);
    expect(h.frames()).toBeLessThanOrEqual(32);
    expect(h.gl.setStyle).toHaveBeenLastCalledWith("glitch");
    h.engine.setInput({ style: "aurora" });
    expect(h.gl.setStyle).toHaveBeenLastCalledWith("aurora");
    const n = h.frames();
    h.run(1000);
    expect(h.frames() - n).toBeGreaterThanOrEqual(29);
  });

  it("u_still: a drifting frame is not still, a frozen one (paused, Still, Reduce motion) is, even mid-fade", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(200);
    expect(h.renders.at(-1)!.still).toBe(false);
    // A track change while playing: the fade runs with the drift, so the glitch burst may show.
    h.engine.setSwatches(pal("#00ff00"), 2);
    h.run(500);
    expect(h.engine.state).toBe("gl-fading");
    expect(h.renders.at(-1)!.still).toBe(false);
    h.engine.setInput({ status: "paused" });
    h.run(100);
    expect(h.renders.at(-1)!.still).toBe(true);
    for (const patch of [{ status: "playing", motion: "still" as const }, { motion: "drift" as const, reducedMotion: true }]) {
      h.engine.setInput(patch);
      h.run(100);
      expect(h.renders.at(-1)!.still).toBe(true);
    }
    // The debug clock hook (window.__bcBackdrop.setTime) jumps the shader clock and redraws once while frozen.
    h.run(2500); // the fade ends, the picture is frozen
    expect(h.engine.state).toBe("gl-frozen");
    const n = h.frames();
    h.engine.setTime(42);
    h.run(100);
    expect(h.engine.time).toBe(42);
    expect(h.renders.at(-1)!.time).toBe(42);
    expect(h.frames()).toBe(n + 1);
  });

  it("a lost context falls back to CSS (no frames) and a restored one draws again", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(500);
    h.hooks().onLost();
    h.run(50);
    expect(h.engine.state).toBe("css");
    const n = h.frames();
    h.run(1000);
    expect(h.frames()).toBe(n);
    h.hooks().onRestored();
    h.run(1000);
    expect(h.engine.state).toBe("gl-drift");
    expect(h.frames()).toBeGreaterThan(n + 25);
  });

  it("a program that fails to compile reports css (the wash shows), and undrawn frames are not counted", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(500);
    const n = h.frames();
    expect(n).toBeGreaterThan(10);
    // A style whose shader does not compile: gl.render draws nothing and the GL layer reports it.
    h.setDraws(false);
    h.engine.setInput({ style: "lava" });
    h.run(100);
    expect(h.frames()).toBe(n);
    h.hooks().onFailed();
    h.run(100);
    expect(h.engine.state).toBe("css");
    expect(h.states.at(-1)).toBe("css");
    h.run(1000);
    expect(h.frames()).toBe(n);
  });

  it("no WebGL at all is the css state; another mode is off; detaching stops everything", () => {
    const h = makeEngine();
    h.setGlAvailable(false);
    h.engine.setInput({ ...morph, status: "playing" });
    h.engine.attach(h.canvas);
    h.run(100);
    expect(h.engine.state).toBe("css");
    expect(h.frames()).toBe(0);
    h.engine.setInput({ mode: "wash" });
    h.run(100);
    expect(h.engine.state).toBe("off");
    h.setGlAvailable(true);
    h.engine.setInput({ mode: "morph" });
    h.engine.attach(h.canvas); // same canvas: no re-init
    expect(h.createGl).toHaveBeenCalledTimes(1);
    h.engine.attach(null);
    h.engine.attach(h.canvas);
    expect(h.createGl).toHaveBeenCalledTimes(2);
    h.run(500);
    expect(h.engine.state).toBe("gl-drift");
    h.engine.dispose();
    const n = h.frames();
    h.run(500);
    expect(h.frames()).toBe(n);
    expect(h.gl.dispose).toHaveBeenCalled();
  });

  it("a resize sets the half-size buffer and redraws one frame while frozen", () => {
    const h = makeEngine();
    h.engine.setInput({ ...morph, status: "paused" });
    h.engine.attach(h.canvas);
    h.engine.setSwatches(pal("#ff0000"), 1);
    h.run(100);
    const n = h.frames();
    h.engine.resize(1400, 900);
    h.run(100);
    expect(h.gl.resize).toHaveBeenLastCalledWith(700, 450);
    expect(h.frames()).toBe(n + 1);
  });
});
