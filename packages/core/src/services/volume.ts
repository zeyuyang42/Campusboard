/**
 * The volume slider's position (0-1) and the gain it sets on the audio element.
 *
 * Loudness is perceived roughly logarithmically, so a linear slider puts most of the audible
 * change in its bottom fifth. The curve is a cube, gain = p^3: it hits 0 and 1 exactly (a
 * dB curve needs a special case for silence at the bottom), has an exact inverse (the cube
 * root, used to convert saved volumes), and spans about 60 dB over the slider, which is
 * close to a dB curve over the range people actually use: half way is -18 dB, and one 5%
 * step near the top is about 1.3 dB.
 *
 * The player stores and saves the position; only web/src/player/store.ts turns it into gain.
 */

/** Saved play states before this curve stored the linear gain in `volume` (version 0). */
export const VOLUME_CURVE_VERSION = 1;
/** One ↑/↓ key press or Volume Up/Down menu item, in slider position. */
export const VOLUME_STEP = 0.05;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Slider position -> gain for `audio.volume`. */
export function positionToGain(position: number): number {
  return clamp01(position) ** 3;
}

/** Gain -> the slider position that gives it (the inverse of positionToGain). */
export function gainToPosition(gain: number): number {
  return Math.cbrt(clamp01(gain));
}

/** Move the slider by `delta`, clamped, without floating-point drift after many steps. */
export function stepVolume(position: number, delta: number): number {
  return clamp01(Math.round((clamp01(position) + delta) * 1000) / 1000);
}

/**
 * The slider position for a saved `volume`: a version-0 save holds a linear gain, which
 * becomes the position that plays at the same gain, so nobody's volume jumps on update.
 */
export function savedVolumeToPosition(volume: number, version: number | null | undefined): number {
  const v = Number.isFinite(volume) ? volume : 1;
  return (version ?? 0) >= 1 ? clamp01(v) : gainToPosition(v);
}
