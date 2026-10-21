// Raw WebGL1 for the morph backdrop (#110): one fullscreen triangle, one program per style
// (compiled on first use), uniforms set each frame. Context loss is handled here: the engine
// only hears onLost / onRestored and falls back to the CSS wash in between.
import type { Backdrop } from "@bc/core";
import { FRAGMENT, VERTEX } from "./shaders";

export interface GlUniforms {
  time: number;
  mix: number;
  intensity: number;
  surface: readonly [number, number, number];
  /** RGB triples in 0..1, exactly SWATCH_SLOTS of them (paletteSlots pads); passed to the uniform as is. */
  colA: Float32Array;
  /** Exactly SWATCH_SLOTS weights. */
  wA: Float32Array;
  colB: Float32Array;
  wB: Float32Array;
  seed: number;
  dark: boolean;
  /** True when the picture is frozen (paused, still, Reduce motion): the glitch style draws no burst then. */
  still: boolean;
}

/** What the engine drives; tests stub it, the app gets createGl's. */
export interface GlLike {
  setStyle(style: Backdrop["style"]): void;
  resize(width: number, height: number): void;
  /** True when a frame was drawn; false when nothing reached the canvas (lost context, no program). */
  render(u: GlUniforms): boolean;
  dispose(): void;
}

/** onFailed: a program would not compile or link, so this canvas cannot be drawn (CSS fallback). */
export interface GlHooks { onLost(): void; onRestored(): void; onFailed(): void }
export type GlFactory = (canvas: HTMLCanvasElement, hooks: GlHooks) => GlLike | null;

interface Program { program: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
const UNIFORMS = ["u_time", "u_res", "u_intensity", "u_mix", "u_surface", "u_colA", "u_wA", "u_colB", "u_wB", "u_seed", "u_dark", "u_still"];

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn("backdrop shader:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: WebGLRenderingContext, frag: string): Program | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.warn("backdrop program:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const loc: Program["loc"] = {};
  for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(program, u);
  return { program, loc };
}

/** True when this webview can draw the morph backdrop at all (the selftest reports it). */
export function webglAvailable(doc: Document = document): boolean {
  try {
    const c = doc.createElement("canvas");
    return !!(c.getContext("webgl") ?? c.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

export const createGl: GlFactory = (canvas, hooks) => {
  const attrs: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = (canvas.getContext("webgl", attrs) ?? canvas.getContext("experimental-webgl", attrs)) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const ctx = gl;
  const programs = new Map<string, Program>();
  let style: Backdrop["style"] = "ink";
  let lost = false;
  let buffer: WebGLBuffer | null = null;

  const setup = () => {
    programs.clear();
    buffer = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);
    ctx.disable(ctx.DEPTH_TEST);
    ctx.disable(ctx.BLEND);
  };
  setup();

  const onLost = (e: Event) => {
    // Without preventDefault the browser never restores the context.
    e.preventDefault();
    lost = true;
    programs.clear();
    hooks.onLost();
  };
  const onRestored = () => {
    lost = false;
    setup();
    hooks.onRestored();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  // A program that fails to compile or link is reported once, so the engine falls back to the
  // CSS wash instead of leaving an undrawn (black, alpha: false) canvas on screen.
  const failed = new Set<string>();
  const current = (): Program | null => {
    let p = programs.get(style);
    if (!p && !failed.has(style)) {
      p = link(ctx, FRAGMENT[style]) ?? undefined;
      if (p) programs.set(style, p);
      else if (!ctx.isContextLost()) { failed.add(style); hooks.onFailed(); }
    }
    return p ?? null;
  };
  // Compile the first style eagerly: a webview whose GLSL support is broken is found now.
  const first = link(ctx, FRAGMENT[style]);
  if (!first) {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    return null;
  }
  programs.set(style, first);

  return {
    setStyle(s) {
      style = s;
      // The new style compiles on the next frame; a failure there reports through onFailed.
    },
    resize(width, height) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.viewport(0, 0, width, height);
    },
    render(u) {
      if (lost) return false;
      const p = current();
      if (!p) return false;
      ctx.useProgram(p.program);
      ctx.uniform1f(p.loc.u_time, u.time);
      ctx.uniform2f(p.loc.u_res, canvas.width, canvas.height);
      ctx.uniform1f(p.loc.u_intensity, u.intensity);
      ctx.uniform1f(p.loc.u_mix, u.mix);
      ctx.uniform3f(p.loc.u_surface, u.surface[0], u.surface[1], u.surface[2]);
      ctx.uniform3fv(p.loc.u_colA, u.colA);
      ctx.uniform1fv(p.loc.u_wA, u.wA);
      ctx.uniform3fv(p.loc.u_colB, u.colB);
      ctx.uniform1fv(p.loc.u_wB, u.wB);
      ctx.uniform1f(p.loc.u_seed, u.seed);
      ctx.uniform1f(p.loc.u_dark, u.dark ? 1 : 0);
      ctx.uniform1f(p.loc.u_still, u.still ? 1 : 0);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      return true;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      for (const p of programs.values()) ctx.deleteProgram(p.program);
      programs.clear();
      if (buffer) ctx.deleteBuffer(buffer);
      // Not WEBGL_lose_context.loseContext(): a canvas keeps its one context, and getContext()
      // on the same element (React StrictMode mounts the effect twice in dev) would hand back
      // the lost one for good. Releasing the programs and buffer is enough.
    },
  };
};
