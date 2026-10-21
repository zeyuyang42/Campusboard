// Raw WebGL1 for the morph backdrop (#110): one fullscreen triangle, one program per style
// (compiled on first use), uniforms set each frame. Context loss is handled here: the engine
// only hears onLost / onRestored and falls back to the CSS wash in between.
import type { Backdrop } from "@bc/core";
import { FRAGMENT, SWATCH_SLOTS, VERTEX } from "./shaders";

export interface GlUniforms {
  time: number;
  mix: number;
  intensity: number;
  surface: readonly [number, number, number];
  /** RGB triples in 0..1, SWATCH_SLOTS of them. */
  colA: Float32Array;
  wA: Float32Array;
  colB: Float32Array;
  wB: Float32Array;
  seed: number;
  dark: boolean;
}

/** What the engine drives; tests stub it, the app gets createGl's. */
export interface GlLike {
  setStyle(style: Backdrop["style"]): void;
  resize(width: number, height: number): void;
  render(u: GlUniforms): void;
  dispose(): void;
}

export interface GlHooks { onLost(): void; onRestored(): void }
export type GlFactory = (canvas: HTMLCanvasElement, hooks: GlHooks) => GlLike | null;

interface Program { program: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
const UNIFORMS = ["u_time", "u_res", "u_intensity", "u_mix", "u_surface", "u_colA", "u_wA", "u_colB", "u_wB", "u_seed", "u_dark"];

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

  const current = (): Program | null => {
    let p = programs.get(style);
    if (!p) {
      p = link(ctx, FRAGMENT[style]) ?? undefined;
      if (p) programs.set(style, p);
    }
    return p ?? null;
  };

  return {
    setStyle(s) { style = s; },
    resize(width, height) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.viewport(0, 0, width, height);
    },
    render(u) {
      if (lost) return;
      const p = current();
      if (!p) return;
      ctx.useProgram(p.program);
      ctx.uniform1f(p.loc.u_time, u.time);
      ctx.uniform2f(p.loc.u_res, canvas.width, canvas.height);
      ctx.uniform1f(p.loc.u_intensity, u.intensity);
      ctx.uniform1f(p.loc.u_mix, u.mix);
      ctx.uniform3f(p.loc.u_surface, u.surface[0], u.surface[1], u.surface[2]);
      ctx.uniform3fv(p.loc.u_colA, u.colA.subarray(0, SWATCH_SLOTS * 3));
      ctx.uniform1fv(p.loc.u_wA, u.wA.subarray(0, SWATCH_SLOTS));
      ctx.uniform3fv(p.loc.u_colB, u.colB.subarray(0, SWATCH_SLOTS * 3));
      ctx.uniform1fv(p.loc.u_wB, u.wB.subarray(0, SWATCH_SLOTS));
      ctx.uniform1f(p.loc.u_seed, u.seed);
      ctx.uniform1f(p.loc.u_dark, u.dark ? 1 : 0);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      for (const p of programs.values()) ctx.deleteProgram(p.program);
      programs.clear();
      if (buffer) ctx.deleteBuffer(buffer);
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
};
