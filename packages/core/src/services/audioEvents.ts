/**
 * What the audio element's play/playing/pause/waiting events do to the player store (#55).
 * Pure so it can be tested in Node; web/src/player/store.ts feeds it the element's state at
 * the moment the event is handled, not when it was queued.
 *
 * - play / playing / waiting arrive as queued tasks, so one can be handled after the listener
 *   already paused (e.g. a stream recovering from buffering just as Pause is pressed). If the
 *   element is paused by then the event is stale and changes nothing; otherwise it would
 *   undo the pause and leave `wantsPlay` set for the next load or retry to act on.
 * - pause from outside the store (the system: an output device gone, WebKit pausing hidden
 *   media) ends the intent to play, so nothing resumes on its own later. A pause the store
 *   causes itself while switching tracks (`internal`) keeps it. The store's own pause() has
 *   already cleared it.
 */
import type { PlayerStatus } from "./nowPlaying.js";

export type AudioEventType = "play" | "playing" | "pause" | "waiting";

export interface AudioElementState {
  /** audio.paused when the event is handled. */
  paused: boolean;
  /** audio.ended when the event is handled. */
  ended: boolean;
  /** The store is loading or switching tracks itself (a pause then is not the listener's). */
  internal: boolean;
}

export interface AudioEventPatch {
  status: PlayerStatus;
  wantsPlay?: boolean;
  error?: null;
}

/** The store update for one event, or null when the event changes nothing. */
export function audioEventPatch(type: AudioEventType, el: AudioElementState): AudioEventPatch | null {
  switch (type) {
    case "play":
    case "playing":
      return el.paused ? null : { status: "playing", wantsPlay: true, error: null };
    case "waiting":
      // Buffering: the playhead stops, the intent to play doesn't (see toggleAction).
      return el.paused ? null : { status: "loading" };
    case "pause":
      if (el.ended) return null; // "ended" follows and decides (next track, or stop)
      return el.internal ? { status: "paused" } : { status: "paused", wantsPlay: false };
  }
}

/** What can change the store's `swapping` flag (load() swapped the source of a playing element). */
export type SwapEvent =
  | { type: "load"; paused: boolean } // load() is about to set a new source
  | { type: "pause" }
  | { type: "playing"; paused: boolean }
  | { type: "error" }
  | { type: "playRejected" };

/**
 * The `swapping` flag after an event. Each load sets it afresh (true only if the element was
 * playing, so a "pause" may follow); that pause, the new track playing, an error or a refused
 * play() clear it, so it can never stay true and swallow a later system pause.
 */
export function swappingAfter(swapping: boolean, ev: SwapEvent): boolean {
  switch (ev.type) {
    case "load": return !ev.paused;
    case "playing": return ev.paused ? swapping : false;
    case "pause":
    case "error":
    case "playRejected":
      return false;
  }
}
