/**
 * What Play/Pause (Space, F8, the player bar, the mini player) does. Pure so it can be tested
 * in Node; web/src/player/store.ts applies it.
 *
 * `status` follows the audio element and goes to "loading" while a track starts and while it
 * buffers mid-track; `wantsPlay` is the listener's intent, set by the store's actions and never
 * by buffering. Toggle pauses whenever playback is intended (playing, or loading/buffering on
 * the way to playing) and plays when paused or stopped, so a press during a stall pauses
 * instead of asking an already-playing element to play again.
 */
import type { PlayerStatus } from "./nowPlaying.js";

export type ToggleAction = "play" | "pause";

export function toggleAction(status: PlayerStatus, wantsPlay: boolean): ToggleAction {
  if (status === "playing") return "pause";
  if (status === "loading") return wantsPlay ? "pause" : "play";
  return "play";
}
