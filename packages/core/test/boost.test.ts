import { describe, it, expect } from "vitest";
import { boostSwatches, BOOST_MIN_WEIGHT, type RawSwatch } from "../src/palette/index.js";
import { hexToRgb, rgbToOklch } from "../src/theme/color.js";

const o = (hex: string) => rgbToOklch(hexToRgb(hex));
const hueDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

const vivid: RawSwatch[] = [
  { hex: "#c8321e", weight: 0.4 }, // red
  { hex: "#1f3f8a", weight: 0.3 }, // blue
  { hex: "#e3b43c", weight: 0.2 }, // yellow
  { hex: "#2f6b3a", weight: 0.1 }, // green
];
const grey: RawSwatch[] = [
  { hex: "#2a2a2a", weight: 0.5 },
  { hex: "#777777", weight: 0.3 },
  { hex: "#c9c9c9", weight: 0.2 },
];

describe("boostSwatches", () => {
  it("raises chroma to at least the floor, caps it, and keeps every hue", () => {
    const b = boostSwatches(vivid, { dark: true });
    expect(b.neutral).toBe(false);
    expect(b.swatches).toHaveLength(4);
    b.swatches.forEach((s, i) => {
      expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.C).toBeLessThanOrEqual(0.22 + 1e-9);
      // toGamut may trim chroma a little; the floor still holds within that margin.
      expect(s.C).toBeGreaterThanOrEqual(Math.min(0.12, o(vivid[i].hex).C * 1.4) * 0.6);
      expect(hueDiff(s.h, o(vivid[i].hex).h)).toBeLessThan(8);
    });
  });

  it("re-spreads lightness by rank into the vivid band, keeping the darker swatch darker", () => {
    const b = boostSwatches(vivid, { dark: true });
    const Ls = b.swatches.map((s) => s.L);
    for (const L of Ls) { expect(L).toBeGreaterThanOrEqual(0.3); expect(L).toBeLessThanOrEqual(0.8); }
    // blue (#1f3f8a) was the darkest input, yellow (#e3b43c) the lightest.
    expect(Ls[1]).toBe(Math.min(...Ls));
    expect(Ls[2]).toBe(Math.max(...Ls));
    expect(new Set(Ls.map((l) => Math.round(l * 100))).size).toBe(4);
  });

  it("turns grey art into a tinted neutral ramp, by appearance", () => {
    const dark = boostSwatches(grey, { dark: true });
    const light = boostSwatches(grey, { dark: false });
    expect(dark.neutral).toBe(true);
    for (const s of dark.swatches) { expect(s.C).toBeGreaterThan(0.03); expect(s.C).toBeLessThan(0.09); expect(s.L).toBeGreaterThanOrEqual(0.29); expect(s.L).toBeLessThanOrEqual(0.71); }
    for (const s of light.swatches) { expect(s.L).toBeGreaterThanOrEqual(0.59); expect(s.L).toBeLessThanOrEqual(0.91); }
    // Pure greys have no hue to borrow: the fallback hue is the blue at 250.
    expect(hueDiff(dark.swatches[0].h, 250)).toBeLessThan(15);
  });

  it("borrows the hue of the most chromatic cluster for a nearly grey cover", () => {
    const warmGrey: RawSwatch[] = [{ hex: "#3a3836", weight: 0.7 }, { hex: "#8a8480", weight: 0.3 }];
    const b = boostSwatches(warmGrey, { dark: true });
    expect(b.neutral).toBe(true);
    const most = warmGrey.map((s) => o(s.hex)).reduce((a, c) => (c.C > a.C ? c : a));
    expect(hueDiff(b.swatches[0].h, most.h)).toBeLessThan(10);
  });

  it("drops clusters under the weight floor, keeps at most six, orders by weight and normalises weights", () => {
    const many: RawSwatch[] = Array.from({ length: 9 }, (_, i) => ({ hex: `#${(i * 28).toString(16).padStart(2, "0")}4a9e`, weight: i === 0 ? 0.01 : 0.11 }));
    const b = boostSwatches(many, { dark: true });
    expect(b.swatches).toHaveLength(6);
    expect(b.swatches.every((s) => s.weight > BOOST_MIN_WEIGHT)).toBe(true);
    const sum = b.swatches.reduce((n, s) => n + s.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    const shuffled = [vivid[2], vivid[0], vivid[3], vivid[1]];
    expect(boostSwatches(shuffled, { dark: true }).swatches.map((s) => Math.round(s.weight * 100) / 100)).toEqual([0.4, 0.3, 0.2, 0.1]);
  });

  it("handles no usable input", () => {
    expect(boostSwatches([], { dark: true })).toEqual({ swatches: [], neutral: true });
    expect(boostSwatches([{ hex: "nope", weight: 1 }, { hex: "#112233", weight: 0.001 }], { dark: true }).swatches).toEqual([]);
  });

  it("is deterministic and returns colours inside sRGB", () => {
    const a = boostSwatches(vivid, { dark: false });
    expect(boostSwatches(vivid, { dark: false })).toEqual(a);
    for (const s of a.swatches) {
      const { r, g, b } = hexToRgb(s.hex);
      for (const v of [r, g, b]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
    }
  });
});
