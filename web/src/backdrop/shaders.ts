// GLSL ES 1.00 for the morph backdrop (#110), as plain strings: no worker, no blob: URL, so
// the CSP is unchanged. Every style shares the header (hash, value noise, fbm, the two
// weighted palettes mixed by u_mix) and ends with mix(u_surface, colour, u_intensity).
import type { Backdrop } from "@bc/core";

export const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/** Slots per palette; a missing swatch has weight 0 and is skipped. */
export const SWATCH_SLOTS = 6;

const HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_time;
uniform vec2 u_res;
uniform float u_intensity;
uniform float u_mix;
uniform vec3 u_surface;
uniform vec3 u_colA[6];
uniform float u_wA[6];
uniform vec3 u_colB[6];
uniform float u_wB[6];
uniform float u_seed;
uniform float u_dark;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
// The colour at t in [0,1] along the swatches laid out by weight, blended across each boundary.
vec3 pal(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 ra = u_colA[0]; vec3 rb = u_colB[0];
  vec3 ca = u_colA[0]; vec3 cb = u_colB[0];
  float pa = 0.0; float pb = 0.0;
  float ma = -1.0; float mb = -1.0;
  for (int i = 0; i < 6; i++) {
    if (u_wA[i] > 0.0) {
      float mid = pa + u_wA[i] * 0.5;
      if (ma < 0.0) ra = u_colA[i];
      else if (t >= ma && t <= mid) ra = mix(ca, u_colA[i], smoothstep(ma, mid, t));
      else if (t > mid) ra = u_colA[i];
      ca = u_colA[i]; ma = mid; pa += u_wA[i];
    }
    if (u_wB[i] > 0.0) {
      float mid = pb + u_wB[i] * 0.5;
      if (mb < 0.0) rb = u_colB[i];
      else if (t >= mb && t <= mid) rb = mix(cb, u_colB[i], smoothstep(mb, mid, t));
      else if (t > mid) rb = u_colB[i];
      cb = u_colB[i]; mb = mid; pb += u_wB[i];
    }
  }
  return mix(ra, rb, u_mix);
}
vec3 finish(vec3 c) { return mix(u_surface, c, u_intensity); }
`;

/** Fluid ink: a two-level domain warp of fbm, about a minute per visible cycle. */
const INK = HEADER + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * 1.6 + u_seed;
  float s = u_time * 0.05;
  vec2 q = vec2(fbm(p + vec2(0.0, s)), fbm(p + vec2(5.2, 1.3) - s * 0.7));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + s * 0.3), fbm(p + 4.0 * q + vec2(8.3, 2.8) - s * 0.2));
  float f = fbm(p + 3.0 * r);
  f = smoothstep(0.18, 0.82, f);
  gl_FragColor = vec4(finish(pal(f)), 1.0);
}
`;

/** Aurora bands: four horizontal bands with sinusoidal and noise undulation, one swatch each. */
const AURORA = HEADER + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float s = u_time * 0.04;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float base = 0.2 + 0.2 * fi;
    float y = base + 0.08 * sin(uv.x * 2.4 + s + fi * 1.7 + u_seed) + 0.07 * (noise(vec2(uv.x * 3.0 + fi * 7.0 + u_seed, s * 0.6)) - 0.5);
    float width = 0.1 + 0.03 * sin(s * 0.5 + fi);
    float d = (uv.y - y) / width;
    float g = exp(-d * d);
    acc += pal((fi + 0.5) / 4.0) * g;
    wsum += g;
  }
  vec3 col = mix(u_surface, acc / max(wsum, 1e-3), clamp(wsum, 0.0, 1.0));
  gl_FragColor = vec4(finish(col), 1.0);
}
`;

/** Grain gradient: five gaussian blobs on slow Lissajous paths, plus hash grain of about 3%. */
const GRAIN = HEADER + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  float s = u_time / 90.0 * 6.2831;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(0.5 + 0.38 * sin(s * (1.0 + 0.3 * fi) + fi * 1.3 + u_seed), 0.5 + 0.38 * sin(s * (1.3 + 0.2 * fi) + fi * 2.1 + u_seed * 0.7));
    vec2 d = (uv - c) * asp;
    float g = exp(-dot(d, d) * 3.5);
    acc += pal((fi + 0.5) / 5.0) * g;
    wsum += g;
  }
  vec3 col = acc / max(wsum, 1e-4);
  float grain = (hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.06;
  col *= 1.0 + grain;
  gl_FragColor = vec4(finish(col), 1.0);
}
`;

/** Lava blobs: five metaballs (sum of w/d²) on 40 s orbits, one swatch each. */
const LAVA = HEADER + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  float s = u_time / 40.0 * 6.2831;
  float field = 0.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ang = s * (0.6 + 0.25 * fi) + fi * 1.26 + u_seed;
    vec2 c = vec2(0.5, 0.5) + vec2(cos(ang), sin(ang * 0.8 + fi)) * (0.18 + 0.07 * fi);
    vec2 d = (uv - c) * asp;
    float w = 0.012 + 0.004 * fi;
    float f = w / max(dot(d, d), 1e-4);
    field += f;
    acc += pal((fi + 0.5) / 5.0) * f;
  }
  vec3 blobCol = acc / max(field, 1e-4);
  float m = smoothstep(0.9, 1.4, field);
  vec3 bgCol = mix(u_surface, pal(0.1), 0.35);
  vec3 col = mix(bgCol, blobCol, m);
  gl_FragColor = vec4(finish(col), 1.0);
}
`;

export const FRAGMENT: Record<Backdrop["style"], string> = { ink: INK, aurora: AURORA, grain: GRAIN, lava: LAVA };
