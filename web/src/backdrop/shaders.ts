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
uniform float u_still;

// hash() loses its randomness once an input passes a few thousand (fract of p * 456 runs out
// of float bits), so nothing that grows with u_time may reach it unbounded: noise() wraps its
// lattice at NOISE_PERIOD cells (every corner, so the wrap is seamless) and the glitch style
// takes its frame and slot counters modulo small numbers.
const float NOISE_PERIOD = 256.0;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cell(vec2 i) { return hash(mod(i, NOISE_PERIOD)); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cell(i), cell(i + vec2(1.0, 0.0)), u.x), mix(cell(i + vec2(0.0, 1.0)), cell(i + vec2(1.0, 1.0)), u.x), u.y);
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

/**
 * Aurora curtains (#113): five tall sheets, one swatch each, hanging from a wavy lower edge and
 * fading toward the top. Each sheet undulates in x along its height (the 17 s wave plus a slow
 * noise wander), is brightest in a narrow core and is streaked by fine vertical rays that
 * follow its folds. Where sheets overlap the colours average and the coverage builds up
 * (a soft union of the gaussians), so they mix without blowing out on a light surface.
 */
const AURORA = HEADER + `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float s = u_time * 0.37;  // 2*pi / 17 s
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    // The sheet's x at this height: spread across the width, swinging with the wave and wandering.
    float x = 0.1 + 0.2 * fi
      + 0.11 * sin(uv.y * 2.2 + s + fi * 1.7 + u_seed)
      + 0.06 * sin(s * 0.41 + fi * 2.3 + u_seed * 0.5)
      + 0.12 * (noise(vec2(uv.y * 1.6 + fi * 7.0 + u_seed, s * 0.35 + fi)) - 0.5);
    float dx = uv.x - x;
    float width = 0.075 + 0.02 * sin(s * 0.6 + fi * 0.9);
    float body = exp(-dx * dx / (width * width));
    float core = exp(-dx * dx / (width * width * 0.12));
    // The lower hem wanders a little; above it the sheet fades out slowly toward the top.
    float hem = 0.07 + 0.05 * sin(uv.x * 3.1 + s * 0.7 + fi);
    float vert = smoothstep(hem, hem + 0.12, uv.y) * (1.0 - 0.6 * smoothstep(hem + 0.2, 1.0, uv.y));
    // Rays: value noise stretched along y and sampled in the sheet's own frame, so the streaks
    // bend with it; two octaves, sliding slowly along the sheet.
    float rx = dx * 70.0 + fi * 31.0 + s * 0.8;
    float r1 = noise(vec2(rx, uv.y * 2.0 + s * 0.2));
    float r2 = noise(vec2(rx * 2.3 + 11.0, uv.y * 3.0 - s * 0.15));
    float rays = 0.35 + 0.65 * smoothstep(0.25, 0.85, 0.6 * r1 + 0.4 * r2);
    float g = body * vert * rays;
    vec3 col = pal((fi + 0.5) / 5.0);
    // A brighter core on a dark surface, a denser one on a light surface.
    col = mix(col, mix(col * 0.82, col * 1.45 + 0.08, u_dark), core * 0.7);
    acc += col * g;
    wsum += g;
  }
  vec3 sheets = acc / max(wsum, 1e-4);
  // Overlaps brighten (dark) or deepen (light) a little, as light would add up; on a light
  // surface the sheets are also a touch deeper overall, or pale swatches vanish into it.
  float over = clamp(wsum - 1.0, 0.0, 1.0);
  sheets *= mix(0.9, 1.0, u_dark) + over * mix(-0.2, 0.3, u_dark);
  float cover = 1.0 - exp(-wsum * mix(2.6, 1.8, u_dark));
  vec3 fill = mix(u_surface, pal(0.5), 0.22);
  vec3 col = mix(fill, sheets, cover);
  gl_FragColor = vec4(finish(col), 1.0);
}
`;

/**
 * Glitch (#113): the palette as 7 hard-edged posterized bands with an ordered (Bayer) dither,
 * calm most of the time, torn by bursts. Everything is a function of u_time (and u_mix): a
 * burst of about 0.5 s starts once in every 5 s slot at a hashed offset (so 2-8 s apart,
 * reproducible), and a track change (u_mix between 0 and 1) is a longer, stronger one. During a
 * burst horizontal slabs of hashed heights tear sideways, re-rolled 8 times a second, some slabs
 * jump to a neighbouring band's colour, the channels split, and a few rectangles of TV static
 * flash. u_still (paused, Still, Reduce motion) clamps the burst to 0, so a frozen frame is never
 * caught mid-tear. The posterize also steps the lightness, so a one-colour palette still bands.
 */
const GLITCH = HEADER + `
const float STEPS = 7.0;
float bayer2(vec2 p) {
  p = mod(floor(p), 2.0);
  return mod(p.x * 3.0 + p.y * 2.0, 4.0);
}
float bayer4(vec2 p) {
  return (4.0 * bayer2(p * 0.5) + bayer2(p)) / 16.0 + 1.0 / 32.0;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float t = u_time;
  // The periodic burst: one per 5 s slot, 0.5 s long, starting 1-4 s into the slot.
  float slot = floor(t / 5.0);
  float sl = mod(slot, 512.0);  // the slot as a hash input: small, so it stays random for hours
  float start = slot * 5.0 + 1.0 + 3.0 * hash(vec2(sl, u_seed));
  float bu = t - start;
  float env = step(0.0, bu) * step(bu, 0.5) * (1.0 - bu / 0.5);
  // The track-change burst rides the cross-fade: strongest half way through it.
  float change = clamp(u_mix * (1.0 - u_mix) * 4.4, 0.0, 1.0);
  float burst = max(env, change) * (1.0 - u_still);
  float frame = mod(floor(t * 8.0), 256.0);  // slabs and static re-roll 8 times a second (bounded, see hash)
  float bseed = hash(vec2(sl + 7.0, u_seed + 3.0)) + change * 0.37;

  // Slabs: coarse and fine, each torn sideways by its own hashed offset when the burst is on.
  vec2 p = uv;
  float shift = 0.0;
  if (burst > 0.0) {
    float n1 = 5.0 + floor(hash(vec2(bseed, 1.0)) * 7.0);
    float b1 = floor(uv.y * n1);
    float h1 = hash(vec2(b1 + frame * 0.37, bseed));
    float tear1 = step(0.45, hash(vec2(b1, frame + bseed)));
    p.x += (h1 - 0.5) * 0.5 * burst * tear1;
    float n2 = 20.0 + floor(hash(vec2(bseed, 2.0)) * 30.0);
    float b2 = floor(uv.y * n2);
    float h2 = hash(vec2(b2 * 1.7 + frame, bseed + 5.0));
    float tear2 = step(0.7, hash(vec2(b2, frame * 0.53 + bseed)));
    p.x += (h2 - 0.5) * 0.18 * burst * tear2;
    // Some slabs jump one or two bands up or down (a shift of 1.4 band widths): a neighbouring swatch.
    float h3 = hash(vec2(b1 + 13.0, frame + bseed * 2.0));
    shift = step(0.6, h3) * (floor(hash(vec2(b1, bseed + 9.0)) * 3.0) - 1.0) * (1.4 / STEPS);
  }
  p.x = fract(p.x);

  // The calm base: a diagonal gradient that leans slowly, posterized with an ordered dither.
  float g = p.y * 0.78 + p.x * 0.28 + 0.07 * sin(p.x * 3.0 + t * 0.09 + u_seed) + 0.05 * sin(p.y * 4.0 - t * 0.07);
  g += (bayer4(gl_FragCoord.xy) - 0.5) * (0.55 / STEPS);  // a dithered fringe, the edges stay hard
  float q = floor(clamp(g + shift, 0.0, 0.999) * STEPS) / STEPS;
  float tc = q + 0.5 / STEPS;
  // The channels split a little while a burst is on.
  float split = 0.06 * burst;
  vec3 col = vec3(pal(tc + split).r, pal(tc).g, pal(tc - split).b);
  // Lightness steps too, so bands show even when every swatch is the same colour (a narrower
  // ramp on a light surface, where pale swatches would clip to white).
  col *= mix(mix(0.78, 1.04, q), mix(0.72, 1.25, q), u_dark);
  col += u_dark * (q - 0.5) * 0.08;

  // TV static: 2-6 rectangles, each flashing on and off every few frames. The speckle is the
  // band colour pushed 35% toward black or white (a modest luminance swing, re-rolled at 8 Hz,
  // never full black/white flicker: photosensitivity).
  if (burst > 0.0) {
    float count = 2.0 + floor(hash(vec2(bseed, 4.0)) * 5.0);
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      if (fi >= count) break;
      vec2 c = vec2(hash(vec2(fi, bseed + 11.0)), hash(vec2(fi + 20.0, bseed + 11.0)));
      vec2 sz = vec2(0.08 + 0.3 * hash(vec2(fi + 40.0, bseed)), 0.03 + 0.14 * hash(vec2(fi + 60.0, bseed)));
      float on = step(0.45, hash(vec2(fi + frame, bseed + 17.0))) * step(0.3, burst);
      vec2 d = abs(uv - c) - sz * 0.5;
      float inside = step(max(d.x, d.y), 0.0) * on;
      float n = hash(gl_FragCoord.xy + mod(frame, 64.0) * 13.7);
      vec3 noiseCol = mix(mix(col, vec3(0.0), 0.35), mix(col, vec3(1.0), 0.35), step(0.5, n));
      col = mix(col, noiseCol, inside * 0.9);
    }
  }
  gl_FragColor = vec4(finish(clamp(col, 0.0, 1.0)), 1.0);
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

export const FRAGMENT: Record<Backdrop["style"], string> = { ink: INK, aurora: AURORA, glitch: GLITCH, lava: LAVA };
