import { quantize } from "./quantize.js";
import { pickColors } from "./pick.js";
import { rgbToHex } from "../theme/color.js";
import { ART_SWATCHES_MAX, type ArtPalette, type ArtSwatches } from "./index.js";

export interface ExtractedArt { palette: ArtPalette; swatches: ArtSwatches }

/**
 * Decode image bytes once in the browser/webview and derive both palettes: the conservative
 * accent/ambient trio (five clusters, as before #110, so cached and fresh art agree) and the
 * raw swatches for the vivid backdrop (six clusters). Needs createImageBitmap + OffscreenCanvas.
 */
export async function extractArt(bytes: ArrayBuffer, size = 48): Promise<ExtractedArt> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    return { palette: pickColors(quantize(data, 5)), swatches: swatchesOf(data) };
  } finally {
    bitmap.close();
  }
}

/** The raw swatches of downscaled RGBA pixels: the k-means clusters as hex, ordered by weight. */
export function swatchesOf(px: Uint8ClampedArray | number[]): ArtSwatches {
  const swatches = quantize(px, ART_SWATCHES_MAX).map((c) => ({ hex: rgbToHex(c.rgb), weight: Math.round(c.weight * 10_000) / 10_000 }));
  return { version: 1, swatches };
}

/** The conservative palette alone (what the cache held before palette v2). */
export async function extractPalette(bytes: ArrayBuffer, size = 48): Promise<ArtPalette> {
  return (await extractArt(bytes, size)).palette;
}
