import { quantize } from "./quantize.js";
import { pickColors } from "./pick.js";
import type { ArtPalette } from "./index.js";

/** Decode image bytes in the browser/webview and derive a palette. Needs createImageBitmap + OffscreenCanvas. */
export async function extractPalette(bytes: ArrayBuffer, size = 48): Promise<ArtPalette> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    return pickColors(quantize(data, 5));
  } finally {
    bitmap.close();
  }
}
