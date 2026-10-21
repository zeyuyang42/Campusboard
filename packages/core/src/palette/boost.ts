// Palette v2 (#110): the vivid colours the backdrop paints with. The raw swatches (up to six
// k-means clusters of the art, cached per image) are boosted here at read time, so tuning
// these numbers never invalidates the cache. Pure: hex in, hex + OKLCH out.
import { hexToRgb, rgbToHex, rgbToOklch, oklchToRgb, toGamut } from "../theme/color.js";
import type { RawSwatch, BoostedSwatch, BoostedPalette } from "./index.js";

/** Clusters under this share of the pixels are noise (a thin outline, a logo). */
export const BOOST_MIN_WEIGHT = 0.02;
export const BOOST_MAX_SWATCHES = 6;
/** Below both, the art reads as grey and gets a tinted neutral instead of boosted mud. */
const NEUTRAL_MEAN_C = 0.03;
const NEUTRAL_MAX_C = 0.06;
const NEUTRAL_C = 0.07;
const NEUTRAL_FALLBACK_HUE = 250;
const CHROMA_GAIN = 1.4;
const CHROMA_FLOOR = 0.12;
const CHROMA_CAP = 0.22;
/** Lightness bands: vivid swatches spread by rank; a neutral by theme appearance. */
const VIVID_L: [number, number] = [0.32, 0.78];
const NEUTRAL_L_DARK: [number, number] = [0.3, 0.7];
const NEUTRAL_L_LIGHT: [number, number] = [0.6, 0.9];

const spread = (i: number, n: number, [lo, hi]: [number, number]) => (n <= 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1));

/**
 * Boost raw art swatches for the backdrop: more chroma, lightness re-spread so adjacent
 * colours read apart, hue kept. Grey art gets a tinted neutral ramp in the hue of its most
 * chromatic cluster. Drops clusters under 2%, keeps at most six, ordered by weight.
 */
export function boostSwatches(raw: readonly RawSwatch[], opts: { dark: boolean }): BoostedPalette {
  const kept = raw
    .filter((s) => s.weight >= BOOST_MIN_WEIGHT && /^#[0-9a-fA-F]{6}$/.test(s.hex))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, BOOST_MAX_SWATCHES)
    .map((s) => ({ weight: s.weight, o: rgbToOklch(hexToRgb(s.hex)) }));
  if (kept.length === 0) return { swatches: [], neutral: true };
  const total = kept.reduce((n, s) => n + s.weight, 0);
  const meanC = kept.reduce((n, s) => n + s.o.C * s.weight, 0) / total;
  const maxC = Math.max(...kept.map((s) => s.o.C));
  const neutral = meanC < NEUTRAL_MEAN_C && maxC < NEUTRAL_MAX_C;
  // Ranks by original lightness, so the re-spread keeps "this one was the darker" intact.
  const byL = kept.map((s, i) => ({ i, L: s.o.L })).sort((a, b) => a.L - b.L);
  const rank = new Array<number>(kept.length);
  byL.forEach((e, r) => { rank[e.i] = r; });
  const finish = (L: number, C: number, h: number): BoostedSwatch => {
    const g = toGamut({ L, C, h });
    return { hex: rgbToHex(oklchToRgb(g)), weight: 0, L: g.L, C: g.C, h: g.h };
  };
  let swatches: BoostedSwatch[];
  if (neutral) {
    const most = kept.reduce((a, b) => (b.o.C > a.o.C ? b : a));
    const h = most.o.C > 0.005 ? most.o.h : NEUTRAL_FALLBACK_HUE;
    const band = opts.dark ? NEUTRAL_L_DARK : NEUTRAL_L_LIGHT;
    swatches = kept.map((s, i) => ({ ...finish(spread(rank[i], kept.length, band), NEUTRAL_C, h), weight: s.weight / total }));
  } else {
    // A grey cluster in a colourful cover (a black border, white type) has no hue worth
    // boosting: it borrows the dominant chromatic one rather than landing on a random tint.
    const dominant = kept.reduce((a, b) => (b.o.C > a.o.C ? b : a)).o.h;
    swatches = kept.map((s, i) => {
      const C = Math.min(CHROMA_CAP, Math.max(CHROMA_FLOOR, s.o.C * CHROMA_GAIN));
      const h = s.o.C < NEUTRAL_MEAN_C ? dominant : s.o.h;
      return { ...finish(spread(rank[i], kept.length, VIVID_L), C, h), weight: s.weight / total };
    });
  }
  return { swatches, neutral };
}
