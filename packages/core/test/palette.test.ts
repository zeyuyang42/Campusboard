import { describe, it, expect } from "vitest";
import { quantize, pickColors, fitPalette, artUrl, swatchesOf, ArtSwatchesSchema } from "../src/palette/index.js";
import { contrast, hexToRgb, rgbToOklch } from "../src/theme/color.js";

function bitmap(colors: [number, number, number][], weights: number[], n = 400): number[] {
  const px: number[] = [];
  colors.forEach(([r, g, b], i) => { for (let k = 0; k < Math.round(n * weights[i]); k++) px.push(r, g, b, 255); });
  return px;
}

describe("palette", () => {
  it("quantize recovers the two colors of a synthetic bitmap with their weights", () => {
    const cl = quantize(bitmap([[220, 40, 40], [30, 30, 120]], [0.7, 0.3]), 2);
    expect(cl).toHaveLength(2);
    expect(cl[0].weight).toBeCloseTo(0.7, 1);
    expect(Math.round(cl[0].rgb.r)).toBe(220);
    expect(Math.round(cl[1].rgb.b)).toBe(120);
  });
  it("ignores transparent pixels and handles empty input", () => {
    expect(quantize([0, 0, 0, 0, 10, 10, 10, 0], 3)).toEqual([]);
    expect(pickColors([]).accent).toBe("#5BB6D1");
  });
  it("picks a vivid accent over a dominant grey, and a different-hued second color", () => {
    const cl = quantize(bitmap([[90, 90, 90], [230, 120, 30], [40, 60, 200]], [0.6, 0.25, 0.15]), 3);
    const p = pickColors(cl);
    expect(p.accent.toLowerCase()).toBe("#e6781e");
    expect(p.ambient1).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p.ambient2).not.toBe(p.ambient1);
  });
  it("fitPalette clamps the accent to 3:1 against the surface and picks readable text", () => {
    const f = fitPalette({ accent: "#2a2d33", ambient1: "#333333", ambient2: "#444444" }, "#23262D");
    expect(contrast(hexToRgb(f.accent), hexToRgb("#23262D"))).toBeGreaterThanOrEqual(3);
    expect(["#000000", "#ffffff"]).toContain(f.accentText);
  });
  it("fitPalette keeps ambient tints light on light surfaces and mid-dark on dark ones", () => {
    const raw = { accent: "#e6781e", ambient1: "#1a1a1a", ambient2: "#f0e0c0" };
    const onLight = fitPalette(raw, "#F5F6F8");
    const onDark = fitPalette(raw, "#23262D");
    expect(rgbToOklch(hexToRgb(onLight.ambient1)).L).toBeGreaterThanOrEqual(0.7);
    expect(rgbToOklch(hexToRgb(onDark.ambient2)).L).toBeLessThanOrEqual(0.56);
  });
  it("swatchesOf (palette v2) gives the raw clusters as hex with weights from the same bitmap pickColors reads", () => {
    const px = bitmap([[90, 90, 90], [230, 120, 30], [40, 60, 200]], [0.6, 0.25, 0.15]);
    const s = swatchesOf(px);
    expect(s.version).toBe(1);
    expect(s.swatches.length).toBeGreaterThanOrEqual(3);
    expect(s.swatches.length).toBeLessThanOrEqual(6);
    expect(s.swatches[0].hex.toLowerCase()).toBe("#5a5a5a"); // the dominant grey comes first
    expect(s.swatches.map((x) => x.weight).reduce((a, b) => a + b)).toBeCloseTo(1, 2);
    for (let i = 1; i < s.swatches.length; i++) expect(s.swatches[i - 1].weight).toBeGreaterThanOrEqual(s.swatches[i].weight);
    expect(s.swatches.map((x) => x.hex.toLowerCase())).toEqual(expect.arrayContaining(["#e6781e", "#283cc8"]));
    expect(ArtSwatchesSchema.safeParse(s).success).toBe(true);
    // The conservative trio is untouched: same five-cluster pick as before.
    expect(pickColors(quantize(px, 5)).accent.toLowerCase()).toBe("#e6781e");
  });
  it("ArtSwatchesSchema refuses what the cache must never hold", () => {
    expect(ArtSwatchesSchema.safeParse({ version: 2, swatches: [] }).success).toBe(false);
    expect(ArtSwatchesSchema.safeParse({ version: 1, swatches: [{ hex: "red", weight: 0.5 }] }).success).toBe(false);
    expect(ArtSwatchesSchema.safeParse({ version: 1, swatches: Array.from({ length: 7 }, () => ({ hex: "#000000", weight: 0.1 })) }).success).toBe(false);
    expect(ArtSwatchesSchema.safeParse({ version: 1, swatches: [{ hex: "#000000", weight: 1.5 }] }).success).toBe(false);
  });
  it("artUrl pads the id", () => {
    expect(artUrl(872064409, 10)).toBe("https://f4.bcbits.com/img/a0872064409_10.jpg");
    expect(artUrl(null)).toBeNull();
  });
});
