import { describe, it, expect } from "vitest";
import { parseTheme, parseThemeJson, PRESETS, DEFAULT_THEME, DEFAULT_BACKDROP, themeVars, backdropVars, applyTheme, fontStack, resolveTheme, PANEL_ALPHA_FLOOR } from "../src/theme/index.js";
import { contrast, ensureContrast, hexToRgb, rgbToOklch, oklchToRgb, rgbToHex } from "../src/theme/color.js";

describe("ThemeSchema", () => {
  it("accepts every preset and round-trips through JSON", () => {
    for (const p of PRESETS) {
      const r = parseThemeJson(JSON.stringify(p));
      expect(r.error).toBeUndefined();
      expect(r.theme).toEqual(p);
    }
  });
  it("rejects bad colors, long fonts, newer versions and non-https backgrounds with readable messages", () => {
    expect(parseTheme({ ...DEFAULT_THEME, palette: { ...DEFAULT_THEME.palette, accent: "red" } }).error).toMatch(/palette.accent/);
    expect(parseTheme({ ...DEFAULT_THEME, fonts: { display: "x".repeat(81), ui: "a" } }).error).toMatch(/fonts.display/);
    expect(parseTheme({ ...DEFAULT_THEME, fonts: { display: "Evil;url(x)", ui: "a" } }).error).toMatch(/fonts.display/);
    expect(parseTheme({ ...DEFAULT_THEME, version: 2 }).error).toMatch(/newer version/);
    expect(parseTheme({ ...DEFAULT_THEME, background: { source: "url", value: "http://x/y.png", blur: 0, dim: 0 } }).error).toMatch(/https/);
    expect(parseThemeJson("{nope").error).toMatch(/JSON/);
  });
  it("strips unknown keys", () => {
    const r = parseTheme({ ...DEFAULT_THEME, extra: 1, palette: { ...DEFAULT_THEME.palette, bonus: "#000000" } });
    expect(r.theme).toBeDefined();
    expect("extra" in r.theme!).toBe(false);
    expect("bonus" in r.theme!.palette).toBe(false);
  });
});

describe("backdrop (#110)", () => {
  const dark = (over: Partial<typeof DEFAULT_BACKDROP> = {}) => resolveTheme({ ...PRESETS[0], backdrop: { ...DEFAULT_BACKDROP, ...over } }, true);

  it("style \"grain\" (the 0.9.0 name) parses as \"glitch\" (#113), version 1; other unknown styles are still refused", () => {
    const r = parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, style: "grain" } });
    expect(r.error).toBeUndefined();
    expect(r.theme?.version).toBe(1);
    expect(r.theme?.backdrop.style).toBe("glitch");
    expect(parseThemeJson(JSON.stringify({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, style: "glitch" } })).theme?.backdrop.style).toBe("glitch");
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, style: "Grain" } }).error).toMatch(/backdrop.style/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, style: "toString" } }).error).toMatch(/backdrop.style/);
  });
  it("a theme without `backdrop` (saved before #110) parses to the morph + ink default, version 1", () => {
    const { backdrop: _dropped, ...old } = PRESETS[0];
    const r = parseTheme(old);
    expect(r.error).toBeUndefined();
    expect(r.theme?.version).toBe(1);
    expect(r.theme?.backdrop).toEqual({ mode: "morph", style: "ink", intensity: 0.7, motion: "drift" });
    expect(DEFAULT_THEME.backdrop).toEqual(DEFAULT_BACKDROP);
    for (const p of PRESETS) expect(p.backdrop).toEqual(DEFAULT_BACKDROP);
  });
  it("rejects values outside the bounds with readable messages", () => {
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, mode: "disco" } }).error).toMatch(/backdrop.mode/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, style: "three.js" } }).error).toMatch(/backdrop.style/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, intensity: 1.5 } }).error).toMatch(/backdrop.intensity/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, intensity: -0.1 } }).error).toMatch(/backdrop.intensity/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { ...DEFAULT_BACKDROP, motion: "fast" } }).error).toMatch(/backdrop.motion/);
    expect(parseTheme({ ...DEFAULT_THEME, backdrop: { mode: "wash" } }).error).toMatch(/backdrop/);
  });
  it("themeVars: conservative is opaque, unblurred, untinted and keeps `ambient` as the wash strength", () => {
    const v = themeVars(dark({ mode: "conservative", intensity: 0.9 }));
    expect(v["--panel-alpha"]).toBe("1");
    expect(v["--panel-blur"]).toBe("0px");
    expect(v["--panel-tint"]).toBe("0");
    expect(v["--ambient-strength"]).toBe(String(PRESETS[0].ambient));
    expect(v["--backdrop-intensity"]).toBe("0.9");
  });
  it("themeVars: the other modes let the backdrop through by intensity, floored for contrast", () => {
    const v = themeVars(dark({ mode: "morph", intensity: 0.7 }));
    expect(Number(v["--panel-alpha"])).toBeCloseTo(0.71, 3);
    expect(v["--panel-blur"]).toBe("28px");
    expect(v["--panel-tint"]).toBe("0.04");
    expect(v["--ambient-strength"]).toBe("0.7");
    expect(Number(themeVars(dark({ mode: "wash", intensity: 1 }))["--panel-alpha"])).toBe(0.68);
    expect(Number(themeVars(dark({ mode: "wash", intensity: 0 }))["--panel-alpha"])).toBe(0.78);
    for (let i = 0; i <= 1; i += 0.05) expect(Number(backdropVars({ backdrop: { ...DEFAULT_BACKDROP, intensity: i } })["--panel-alpha"])).toBeGreaterThanOrEqual(PANEL_ALPHA_FLOOR);
  });
  it("applyTheme writes data-backdrop, so the stylesheet can scope the vivid rules", () => {
    const root = { style: { setProperty: () => undefined }, dataset: {} as DOMStringMap };
    applyTheme(dark({ mode: "conservative" }), root);
    expect(root.dataset.backdrop).toBe("conservative");
    expect(root.dataset.theme).toBe("dark");
    applyTheme(dark({ mode: "morph" }), root);
    expect(root.dataset.backdrop).toBe("morph");
  });
});

describe("themeVars", () => {
  it("emits the full variable set and clamps a low-contrast accent", () => {
    const v = themeVars(resolveTheme({ ...PRESETS[0], palette: { ...PRESETS[0].palette, accent: "#2A2D33" } }, true));
    expect(v["--surface"]).toBe("#23262D");
    expect(contrast(hexToRgb(v["--accent-fallback"]), hexToRgb("#23262D"))).toBeGreaterThanOrEqual(3);
    expect(v["--row-h"]).toBe("48px");
    expect(v["--font-display"]).toContain("Bricolage Grotesque Variable");
  });
  it("builds font stacks that always end in the bundled faces", () => {
    expect(fontStack("Georgia", "display")).toBe(`"Georgia", "Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif`);
    expect(fontStack("Instrument Sans Variable", "ui")).toBe(`"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif`);
    expect(fontStack('x" ; url(', "ui")).not.toContain('"x" ;');
  });
});

describe("color", () => {
  it("round-trips sRGB through OKLCH", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#5BB6D1", "#23262D", "#f5f6f8"]) {
      const back = rgbToHex(oklchToRgb(rgbToOklch(hexToRgb(hex))));
      expect(back.toLowerCase()).toBe(hex.toLowerCase());
    }
  });
  it("ensureContrast reaches 3:1 on dark and light surfaces while keeping hue", () => {
    const surfaces = ["#23262D", "#F5F6F8", "#2A2320", "#EFEBE3"].map(hexToRgb);
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed % 256; };
    for (let i = 0; i < 200; i++) {
      const c = { r: rnd(), g: rnd(), b: rnd() };
      for (const s of surfaces) {
        const out = ensureContrast(c, s, 3);
        expect(contrast(out, s)).toBeGreaterThanOrEqual(3 - 1e-9);
        const h0 = rgbToOklch(c), h1 = rgbToOklch(out);
        if (h0.C > 0.03 && h1.C > 0.03) {
          const dh = Math.abs(((h1.h - h0.h + 540) % 360) - 180);
          expect(dh).toBeLessThan(6);
        }
      }
    }
  });
});
