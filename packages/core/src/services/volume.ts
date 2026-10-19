/**
 * The volume slider's position (0-1) and the gain it sets on the audio element.
 *
 * Loudness is perceived roughly logarithmically, so a linear slider puts most of the audible
 * change in its bottom fifth. The curve is a cube, gain = p^3: it hits 0 and 1 exactly (a
 * dB curve needs a special case for silence at the bottom), has an exact inverse (the cube
 * root) and spans about 60 dB over the slider, close to a dB curve over the range people
 * actually use: half way is -18 dB, and one 5% step near the top is about 1.3 dB.
 *
 * The saved play state keeps the GAIN (`play_state.volume`, as every build before the curve
 * did): the player derives the slider position from it on load and saves position^3. So a
 * library plays at the same loudness in any build, older or newer, with no migration.
 */

/** One ↑/↓ key press or Volume Up/Down menu item, in slider position. */
export const VOLUME_STEP = 0.05;

/** Where unmuting goes when there is no level from before the mute: the old default gain 0.8 (about -1.9 dB). */
export const UNMUTE_GAIN = 0.8;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Slider position -> gain for `audio.volume` and the saved play state. */
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
 * The Mute button: from a level, mute and remember it; from silence, go back to the level
 * from before the mute, or to UNMUTE_GAIN's position when there is none.
 */
export function toggleMute(position: number, beforeMute: number | null): { position: number; beforeMute: number | null } {
  if (clamp01(position) > 0) return { position: 0, beforeMute: clamp01(position) };
  return { position: beforeMute && beforeMute > 0 ? clamp01(beforeMute) : gainToPosition(UNMUTE_GAIN), beforeMute: null };
}
