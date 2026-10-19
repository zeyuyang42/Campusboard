import { describe, expect, it } from "vitest";
import { formatSleepLeft, positionToGain, sleepChoiceOf, sleepGain, sleepScale, sleepSecondsLeft, sleepStopsAtEnd, sleepTimerFor } from "../src/index.js";

describe("sleep timer rules (#70)", () => {
  it("makes a timer from each choice and reads the choice back", () => {
    expect(sleepTimerFor("off", 0)).toBeNull();
    expect(sleepTimerFor(45, 1000)).toEqual({ kind: "minutes", minutes: 45, endsAt: 1000 + 45 * 60_000 });
    for (const c of ["off", 15, 30, 45, 60, "track", "album"] as const) expect(sleepChoiceOf(sleepTimerFor(c, 0))).toBe(c);
  });

  it("stops at a track's end for end of track, and at an album change for end of album", () => {
    const a = { album_id: 1 }, b = { album_id: 2 };
    expect(sleepStopsAtEnd({ kind: "track" }, a, a)).toBe(true);
    expect(sleepStopsAtEnd({ kind: "album" }, a, a)).toBe(false);
    expect(sleepStopsAtEnd({ kind: "album" }, a, b)).toBe(true);
    expect(sleepStopsAtEnd({ kind: "album" }, a, null)).toBe(true);
    expect(sleepStopsAtEnd(sleepTimerFor(15, 0), a, null)).toBe(false);
    expect(sleepStopsAtEnd(null, a, null)).toBe(false);
  });

  it("counts seconds left and fades over the last ten through the volume curve", () => {
    expect(sleepSecondsLeft(sleepTimerFor(15, 0)!, 60_000, false, { currentTime: 0, duration: NaN })).toBe(14 * 60);
    expect(sleepSecondsLeft({ kind: "track" }, 0, true, { currentTime: 95, duration: 100 })).toBe(5);
    expect(sleepSecondsLeft({ kind: "track" }, 0, true, { currentTime: 0, duration: NaN })).toBe(Infinity);
    expect(sleepSecondsLeft({ kind: "album" }, 0, false, { currentTime: 95, duration: 100 })).toBe(Infinity);
    expect([sleepScale(Infinity), sleepScale(10), sleepScale(5), sleepScale(0), sleepScale(-3)]).toEqual([1, 1, 0.5, 0, 0]);
    expect(sleepGain(0.8, 0.5)).toBeCloseTo(positionToGain(0.4), 12);
  });

  it("formats the countdown as m:ss", () => {
    expect(formatSleepLeft(900)).toBe("15:00");
    expect(formatSleepLeft(59.2)).toBe("1:00");
    expect(formatSleepLeft(5)).toBe("0:05");
    expect(formatSleepLeft(-1)).toBe("0:00");
  });
});
