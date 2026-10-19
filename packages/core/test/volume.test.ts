import { describe, it, expect } from "vitest";
import { gainToPosition, positionToGain, savedVolumeToPosition, stepVolume, VOLUME_CURVE_VERSION, VOLUME_STEP } from "../src/services/volume.js";
import { getPlayState, setPlayState, VOLUME_VERSION_KEY } from "../src/db/repos/playState.js";
import { getSetting } from "../src/db/repos/settings.js";
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
  it("converts a saved linear gain once, to the position with the same gain", () => {
    for (const g of [0, 0.1, 0.35, 0.8, 1]) {
      const p = savedVolumeToPosition(g, 0);
      expect(positionToGain(p)).toBeCloseTo(g, 9);
    }
    expect(savedVolumeToPosition(0.5, undefined)).toBeCloseTo(Math.cbrt(0.5), 9);
    expect(savedVolumeToPosition(0.5, VOLUME_CURVE_VERSION)).toBe(0.5);
  });
});

describe("play_state volume version", () => {
  const state = (volume: number) => ({ current_track_id: null, position_sec: 0, queue: [], queue_index: 0, shuffle: false, repeat: "off" as const, volume, volume_version: VOLUME_CURVE_VERSION });

  it("reads a library saved before the curve as version 0 and marks it on the next save", async () => {
    const db = new NodeDb();
    await db.run("UPDATE play_state SET volume = 0.3 WHERE id = 1"); // an older build's save
    const before = await getPlayState(db);
    expect(before.volume_version).toBe(0);
    const position = savedVolumeToPosition(before.volume, before.volume_version);
    expect(positionToGain(position)).toBeCloseTo(0.3, 9);

    await setPlayState(db, state(position));
    const after = await getPlayState(db);
    expect(after.volume_version).toBe(VOLUME_CURVE_VERSION);
    expect(await getSetting(db, VOLUME_VERSION_KEY)).toBe(VOLUME_CURVE_VERSION);
    // Read back once more: the position is kept, not converted a second time.
    expect(savedVolumeToPosition(after.volume, after.volume_version)).toBeCloseTo(position, 9);
  });
});
