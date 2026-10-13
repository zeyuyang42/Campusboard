import { rgbToOklch, oklchToRgb, rgbToHex, toGamut, type RGB } from "../theme/color.js";
import type { Cluster } from "./quantize.js";
import type { ArtPalette } from "./index.js";

/**
 * Choose an accent and two ambient colors from quantized clusters.
 * Accent: the most "alive" cluster (chroma weighted by presence, mid lightness preferred).
 * Ambient 1: the accent softened. Ambient 2: the most present cluster that differs in hue, softened.
 * Colors are returned raw (not contrast-clamped); clamping happens against the active theme.
 */
export function pickColors(clusters: Cluster[]): ArtPalette {
  if (clusters.length === 0) return { accent: "#5BB6D1", ambient1: "#5BB6D1", ambient2: "#5BB6D1" };
  const scored = clusters.map((c) => {
    const o = rgbToOklch(c.rgb);
    const midness = 1 - Math.min(1, Math.abs(o.L - 0.6) / 0.5); // prefer L around 0.6
    return { c, o, score: (o.C + 0.02) * Math.sqrt(c.weight) * (0.4 + 0.6 * midness) };
  });
  scored.sort((a, b) => b.score - a.score);
  const accent = scored[0];
  const hueDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const second =
    scored.slice(1).sort((a, b) => b.c.weight - a.c.weight).find((s) => hueDiff(s.o.h, accent.o.h) > 30 || s.o.C < 0.04) ??
    scored[1] ?? accent;
  const soften = (rgb: RGB, chroma: number, L?: number) => {
    const o = rgbToOklch(rgb);
    return rgbToHex(oklchToRgb(toGamut({ L: L ?? Math.max(0.35, Math.min(0.75, o.L)), C: o.C * chroma, h: o.h })));
  };
  return {
    accent: rgbToHex(accent.c.rgb),
    ambient1: soften(accent.c.rgb, 0.7),
    ambient2: soften(second.c.rgb, 0.6),
  };
}
