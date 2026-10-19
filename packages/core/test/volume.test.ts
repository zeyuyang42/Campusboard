import { describe, it, expect } from "vitest";
import { gainToPosition, positionToGain, stepVolume, toggleMute, UNMUTE_GAIN, VOLUME_STEP } from "../src/services/volume.js";
import { getPlayState, setPlayState } from "../src/db/repos/playState.js";
import { NodeDb } from "./helpers/nodeDb.js";

const grid = Array.from({ length: 101 }, (_, i) => i / 100);

describe("volume curve (#36)", () => {
  it("maps the ends exactly", () => {
    expect(positionToGain(0)).toBe(0);
    expect(positionToGain(1)).toBe(1);
    expect(gainToPosition(0)).toBe(0);
    expect(gainToPosition(1)).toBe(1);
  });
  it("is strictly increasing", () => {
    for (let i = 1; i < grid.length; i++) expect(positionToGain(grid[i])).toBeGreaterThan(positionToGain(grid[i - 1]));
  });
  it("puts the audible range across the slider, not its bottom fifth", () => {
    expect(positionToGain(0.5)).toBeCloseTo(0.125, 6); // about -18 dB
    expect(positionToGain(0.2)).toBeLessThan(0.01);
  });
  it("has an exact inverse both ways", () => {
    for (const p of grid) expect(gainToPosition(positionToGain(p))).toBeCloseTo(p, 9);
    for (const g of grid) expect(positionToGain(gainToPosition(g))).toBeCloseTo(g, 9);
  });
  it("clamps out-of-range and non-finite input", () => {
    expect(positionToGain(-1)).toBe(0);
    expect(positionToGain(2)).toBe(1);
    expect(positionToGain(Number.NaN)).toBe(0);
    expect(gainToPosition(5)).toBe(1);
  });
  it("steps the position, clamped, without drift", () => {
    let p = 0;
    for (let i = 0; i < 20; i++) p = stepVolume(p, VOLUME_STEP);
    expect(p).toBe(1);
    expect(stepVolume(1, VOLUME_STEP)).toBe(1);
    expect(stepVolume(0.02, -VOLUME_STEP)).toBe(0);
    expect(stepVolume(0.5, -VOLUME_STEP)).toBe(0.45);
  });
});

describe("mute", () => {
  it("remembers the level and goes back to it", () => {
    const muted = toggleMute(0.6, null);
    expect(muted).toEqual({ position: 0, beforeMute: 0.6 });
    expect(toggleMute(muted.position, muted.beforeMute)).toEqual({ position: 0.6, beforeMute: null });
  });
  it("unmutes to the old default gain (about -1.9 dB) when there is no level to go back to", () => {
    const r = toggleMute(0, null);
    expect(positionToGain(r.position)).toBeCloseTo(UNMUTE_GAIN, 9);
    expect(20 * Math.log10(positionToGain(r.position))).toBeCloseTo(-1.94, 2);
  });
});

describe("saved volume stays a gain", () => {
  // play_state.volume is what every build reads as audio.volume; the player saves position^3
  // and derives the position on load, so neither an upgrade nor a downgrade changes loudness.
  it("round-trips a slider position through the saved gain", async () => {
    const db = new NodeDb();
    for (const position of [0, 0.3, 0.5, 0.93, 1]) {
      const s = await getPlayState(db);
      await setPlayState(db, { ...s, volume: positionToGain(position) });
      const saved = (await getPlayState(db)).volume;
      expect(saved).toBeCloseTo(positionToGain(position), 12); // an older build plays exactly this gain
      expect(gainToPosition(saved)).toBeCloseTo(position, 9);
    }
  });
  it("reads a library saved before the curve at the same loudness", async () => {
    const db = new NodeDb();
    await db.run("UPDATE play_state SET volume = 0.3 WHERE id = 1"); // an older build's save
    const position = gainToPosition((await getPlayState(db)).volume);
    expect(positionToGain(position)).toBeCloseTo(0.3, 9);
  });
});
