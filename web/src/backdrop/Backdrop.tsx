// The fixed layer behind the shell (#110): the optional background image, then the album-art
// backdrop in the theme's mode. Conservative renders exactly the DOM from before the backdrop
// existed (.ambient > .bg + .wash); wash adds the drifting CSS layers; morph adds a WebGL
// canvas and keeps the wash as the fallback for a lost or missing context. No fade-in on mount.
import { useEffect, useRef, useState } from "react";
import type { Backdrop as BackdropSettings } from "@bc/core";
import { useTheme } from "../theme/store";
import { usePlayer } from "../player/store";
import { BackdropEngine, seedFor } from "./engine";
import { createGl } from "./gl";
import { currentSwatches, currentSwatchKey, onSwatchesChange } from "./swatches";
import type { BackdropState } from "./controller";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** The one engine for the window; it outlives the canvas (mode switches remount it). */
export const engine = new BackdropEngine({
  createGl,
  now: () => performance.now(),
  schedule: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id as number),
});

declare global {
  interface Window { __bcBackdrop?: { readonly state: BackdropState; readonly frames: number } }
}
if (typeof window !== "undefined") {
  window.__bcBackdrop = { get state() { return engine.state; }, get frames() { return engine.frames; } };
}

export function Backdrop() {
  const backdrop = useTheme((s) => s.resolved.backdrop);
  const status = usePlayer((s) => s.status);
  const paused = status !== "playing" || backdrop.motion === "still";
  // The engine learns the mode here too, so it reports "off" (and does nothing) outside morph.
  useEffect(() => { engine.setInput({ mode: backdrop.mode }); }, [backdrop.mode]);
  if (backdrop.mode === "conservative") {
    return (
      <div className="ambient" aria-hidden="true">
        <div className="bg" />
        <div className="wash" />
      </div>
    );
  }
  if (backdrop.mode === "wash") {
    return (
      <div className="ambient" aria-hidden="true" data-paused={paused ? "" : undefined}>
        <div className="bg" />
        <div className="wash drift" />
      </div>
    );
  }
  return <Morph backdrop={backdrop} status={status} />;
}

function Morph({ backdrop, status }: { backdrop: BackdropSettings; status: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surface = useTheme((s) => s.resolved.palette.surface);
  const dark = useTheme((s) => s.resolved.mode === "dark");
  const [glState, setGlState] = useState<BackdropState>(engine.state);

  useEffect(() => {
    const canvas = canvasRef.current;
    const off = engine.onChange(setGlState);
    const resize = () => engine.resize(window.innerWidth, window.innerHeight);
    const visibility = () => engine.setInput({ hidden: document.visibilityState === "hidden" });
    let mql: MediaQueryList | null = null;
    try { mql = window.matchMedia?.(REDUCED_MOTION) ?? null; } catch { mql = null; }
    const motion = () => engine.setInput({ reducedMotion: !!mql?.matches });
    const swatches = () => engine.setSwatches(currentSwatches(), seedFor(currentSwatchKey()));
    const offSwatches = onSwatchesChange(swatches);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", visibility);
    mql?.addEventListener("change", motion);
    resize();
    visibility();
    motion();
    engine.attach(canvas);
    swatches();
    setGlState(engine.state);
    return () => {
      off();
      offSwatches();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", visibility);
      mql?.removeEventListener("change", motion);
      engine.attach(null);
    };
  }, []);

  useEffect(() => {
    engine.setInput({ mode: backdrop.mode, style: backdrop.style, intensity: backdrop.intensity, motion: backdrop.motion, status, surface, dark });
  }, [backdrop.mode, backdrop.style, backdrop.intensity, backdrop.motion, status, surface, dark]);

  const gl = glState === "css" ? "lost" : "ok";
  return (
    <div className="ambient" aria-hidden="true" data-gl={gl} data-paused={glState === "gl-drift" ? undefined : ""}>
      <div className="bg" />
      <canvas ref={canvasRef} className="morph" />
      <div className="wash" />
    </div>
  );
}
