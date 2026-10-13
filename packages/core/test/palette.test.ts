import { describe, it, expect } from "vitest";
import { quantize, pickColors, fitPalette, artUrl } from "../src/palette/index.js";
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
  it("artUrl pads the id", () => {
    expect(artUrl(872064409, 10)).toBe("https://f4.bcbits.com/img/a0872064409_10.jpg");
    expect(artUrl(null)).toBeNull();
  });
});
