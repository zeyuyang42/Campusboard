import { describe, it, expect } from "vitest";
import { toggleAction } from "../src/services/playerToggle.js";
import type { PlayerStatus } from "../src/services/nowPlaying.js";

describe("toggleAction (#50)", () => {
  // [status, wantsPlay, expected]
  const cases: [PlayerStatus, boolean, "play" | "pause", string][] = [
    ["playing", true, "pause", "playing"],
    ["playing", false, "pause", "playing, intent not yet recorded"],
    ["loading", true, "pause", "buffering mid-track, or a track starting to play"],
    ["loading", false, "play", "loading without intent (autoplay refused)"],
    ["paused", false, "play", "paused by the listener"],
    ["paused", true, "play", "paused by the system (e.g. output device gone)"],
    ["idle", false, "play", "nothing loaded"],
    ["idle", true, "play", "nothing loaded, stale intent"],
  ];
  for (const [status, wantsPlay, expected, why] of cases) {
    it(`${status} + wantsPlay=${wantsPlay} -> ${expected} (${why})`, () => {
      expect(toggleAction(status, wantsPlay)).toBe(expected);
    });
  }
});
