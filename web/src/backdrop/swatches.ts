// The playing track's boosted swatches (#110), a module store like theme/usePalette.ts:
// usePalette publishes the raw swatches it fetched with the palette, this boosts them for the
// current appearance, and the morph backdrop and the mini bridge read the result.
import { boostSwatches, type BoostedPalette, type RawSwatch } from "@bc/core";

let raw: RawSwatch[] | null = null;
let key: number | null = null;
let dark = true;
let boosted: BoostedPalette | null = null;
const listeners = new Set<() => void>();

/** The boosted palette of the current art, or null when nothing is playing or the art is unknown. */
export const currentSwatches = () => boosted;
/** The art key the swatches belong to (art_id, or -image_id for a Radio episode). */
export const currentSwatchKey = () => key;

export function onSwatchesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function reboost() {
  boosted = raw && raw.length ? boostSwatches(raw, { dark }) : null;
}

/** New art (or none): boost and tell the listeners. */
export function publishSwatches(artKey: number | null, swatches: RawSwatch[] | null) {
  key = artKey;
  raw = swatches;
  reboost();
  listeners.forEach((fn) => fn());
}

/** The theme turned dark or light: the same art boosts into the other lightness band. */
export function setSwatchAppearance(isDark: boolean) {
  if (isDark === dark) return;
  dark = isDark;
  reboost();
  listeners.forEach((fn) => fn());
}
