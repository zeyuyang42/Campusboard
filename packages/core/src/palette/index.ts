/** Colors derived from a piece of album art, all as 6-digit hex, not yet clamped to a theme. */
export interface ArtPalette {
  accent: string;
  ambient1: string;
  ambient2: string;
}

/** Palette v2 (#110): one raw k-means cluster of the art, as cached (`art_swatches`). */
export interface RawSwatch { hex: string; weight: number }
/** The cached row: up to six raw clusters, ordered by weight. Boosting happens at read time. */
export interface ArtSwatches { version: 1; swatches: RawSwatch[] }
/** A swatch after boostSwatches: the painted hex plus its OKLCH, weight normalised to 1. */
export interface BoostedSwatch { hex: string; weight: number; L: number; C: number; h: number }
/** What the backdrop paints with. `neutral`: the art was grey, so these are a tinted neutral ramp. */
export interface BoostedPalette { swatches: BoostedSwatch[]; neutral: boolean }

export const ART_SWATCHES_VERSION = 1;
export const ART_SWATCHES_MAX = 6;
export const ArtSwatchesSchema = z.object({
  version: z.literal(1),
  swatches: z.array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), weight: z.number().min(0).max(1) })).max(ART_SWATCHES_MAX),
});

export { quantize, type Cluster } from "./quantize.js";
export { pickColors } from "./pick.js";
export { extractPalette, extractArt, swatchesOf, type ExtractedArt } from "./extract.js";
export { boostSwatches, BOOST_MIN_WEIGHT, BOOST_MAX_SWATCHES } from "./boost.js";

import { z } from "zod";
import { ensureContrast, hexToRgb, rgbToHex, textOn, rgbToOklch, oklchToRgb, toGamut } from "../theme/color.js";

export interface AppliedPalette { accent: string; accentText: string; ambient1: string; ambient2: string }

/** Fit a raw art palette to a theme surface so the accent stays readable. */
export function fitPalette(p: ArtPalette, surfaceHex: string, minRatio = 3): AppliedPalette {
  const surface = hexToRgb(surfaceHex);
  const accent = ensureContrast(hexToRgb(p.accent), surface, minRatio);
  const light = rgbToOklch(surface).L > 0.6;
  // Ambient washes must read as a tint of the surface: keep them light on light themes and
  // mid-dark on dark themes, otherwise dark art turns a light theme into a grey smudge.
  const tint = (hex: string) => {
    const o = rgbToOklch(hexToRgb(hex));
    const L = light ? Math.max(0.72, Math.min(0.9, o.L)) : Math.max(0.3, Math.min(0.55, o.L));
    return rgbToHex(oklchToRgb(toGamut({ L, C: Math.min(o.C, light ? 0.12 : 0.14), h: o.h })));
  };
  return { accent: rgbToHex(accent), accentText: textOn(accent), ambient1: tint(p.ambient1), ambient2: tint(p.ambient2) };
}

/** Bandcamp art CDN sizes: 7 = 160px, 2 = 350px, 16 = 700px, 10 = 1200px. */
export type ArtSize = 7 | 2 | 16 | 10;
export function artUrl(artId: number | null | undefined, size: ArtSize = 16): string | null {
  if (!artId) return null;
  return `https://f4.bcbits.com/img/a${String(artId).padStart(10, "0")}_${size}.jpg`;
}
