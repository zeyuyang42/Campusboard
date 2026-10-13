import type { RGB } from "../theme/color.js";

export interface Cluster { rgb: RGB; weight: number }

/**
 * Small k-means over RGBA pixel data. Input is expected to be a downscaled bitmap
 * (around 48–64px square); transparent pixels are ignored. Deterministic seeding so
 * results are stable for the same image.
 */
export function quantize(px: Uint8ClampedArray | number[], k = 5, iterations = 10): Cluster[] {
  const pts: RGB[] = [];
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    pts.push({ r: px[i], g: px[i + 1], b: px[i + 2] });
  }
  if (pts.length === 0) return [];
  // Seed: spread picks along the sorted-by-luma list so seeds cover the range.
  const sorted = pts.slice().sort((a, b) => a.r + a.g + a.b - (b.r + b.g + b.b));
  let centers: RGB[] = Array.from({ length: Math.min(k, pts.length) }, (_, i) => ({ ...sorted[Math.floor(((i + 0.5) / k) * sorted.length)] }));
  let assign = new Int32Array(pts.length);
  for (let it = 0; it < iterations; it++) {
    for (let p = 0; p < pts.length; p++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (pts[p].r - centers[c].r) ** 2 + (pts[p].g - centers[c].g) ** 2 + (pts[p].b - centers[c].b) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[p] = best;
    }
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let p = 0; p < pts.length; p++) { const s = sums[assign[p]]; s.r += pts[p].r; s.g += pts[p].g; s.b += pts[p].b; s.n++; }
    centers = centers.map((c, i) => (sums[i].n ? { r: sums[i].r / sums[i].n, g: sums[i].g / sums[i].n, b: sums[i].b / sums[i].n } : c));
  }
  const counts = centers.map(() => 0);
  for (let p = 0; p < pts.length; p++) counts[assign[p]]++;
  return centers
    .map((rgb, i) => ({ rgb, weight: counts[i] / pts.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}
