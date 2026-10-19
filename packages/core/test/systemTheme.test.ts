import { describe, it, expect } from "vitest";
import {
  parseTheme, PRESETS, DEFAULT_THEME, LEGACY_DEFAULT_THEME, presetByName, resolveTheme, withMode, withPalette, themeVars, accentRatio, accentSurface,
  type Theme,
} from "../src/theme/index.js";
import { contrast, hexToRgb } from "../src/theme/color.js";
import { fitPalette } from "../src/palette/index.js";

// A theme file exactly as builds before #43 exported it: no pair, no contrast field.
const V1_DARK = {
  version: 1, name: "My Dusk", mode: "dark",
  palette: { surface: "#23262D", surfaceRaised: "#2C3038", text: "#F1EEE9", textMuted: "#9A9AA6", accent: "#5BB6D1", danger: "#E06A5E" },
  radius: 10, density: "comfortable", fonts: { display: "Bricolage Grotesque Variable", ui: "Instrument Sans Variable" }, ambient: 0.6,
  background: { source: "none", value: "", blur: 12, dim: 0.5 },
};
const V1_LIGHT = { ...V1_DARK, name: "My Daylight", mode: "light", palette: PRESETS[1].palette };
const ratio = (a: string, b: string) => contrast(hexToRgb(a), hexToRgb(b));
const HC = presetByName("High contrast")!;

describe("system mode: schema compatibility", () => {
  it("still accepts version 1 dark and light files unchanged, defaulting contrast to standard", () => {
    for (const f of [V1_DARK, V1_LIGHT]) {
      const r = parseTheme(f);
      expect(r.error).toBeUndefined();
      expect(r.theme).toEqual({ ...f, contrast: "standard" });
    }
  });
  it("keeps the version at 1 and accepts a system theme with both palettes", () => {
    expect(DEFAULT_THEME.version).toBe(1);
    expect(DEFAULT_THEME.mode).toBe("system");
    const sys = { ...V1_DARK, mode: "system", paletteDark: V1_DARK.palette, paletteLight: PRESETS[1].palette };
    expect(parseTheme(sys).theme?.mode).toBe("system");
    expect(parseTheme(JSON.parse(JSON.stringify(DEFAULT_THEME))).theme).toEqual(DEFAULT_THEME);
  });
  it("refuses a system theme missing a side, bad pair colors and unknown modes or contrast levels", () => {
    expect(parseTheme({ ...V1_DARK, mode: "system" }).error).toMatch(/mode: a system theme needs both/);
    expect(parseTheme({ ...V1_DARK, mode: "system", paletteDark: V1_DARK.palette }).error).toMatch(/both/);
    expect(parseTheme({ ...V1_DARK, paletteLight: { ...V1_DARK.palette, text: "white" } }).error).toMatch(/paletteLight.text/);
    expect(parseTheme({ ...V1_DARK, mode: "auto" }).error).toMatch(/^mode/);
    expect(parseTheme({ ...V1_DARK, contrast: "max" }).error).toMatch(/^contrast/);
  });
  it("a dark or light file with a pair still reads as the same theme where the pair is ignored", () => {
    // Older builds drop the unknown pair and contrast keys: what they keep is a complete v1 theme.
    const { paletteDark: _d, paletteLight: _l, contrast: _c, ...older } = PRESETS[2];
    expect(parseTheme(older).theme?.palette).toEqual(PRESETS[2].palette);
  });
  it("gives every preset a dark and a light side, with the side for its own mode as palette", () => {
    for (const p of PRESETS) {
      expect(p.paletteDark && p.paletteLight).toBeTruthy();
      expect(p.palette).toEqual(p.mode === "dark" ? p.paletteDark : p.paletteLight);
    }
    expect(LEGACY_DEFAULT_THEME).toEqual({ ...DEFAULT_THEME, mode: "dark" });
  });
});

describe("resolveTheme", () => {
  it("leaves dark and light themes alone whatever the system says", () => {
    for (const sys of [true, false]) {
      expect(resolveTheme(PRESETS[0], sys)).toBe(PRESETS[0]);
      expect(resolveTheme(PRESETS[1], sys)).toBe(PRESETS[1]);
    }
  });
  it("picks the side matching the system appearance for a system theme", () => {
    const dark = resolveTheme(DEFAULT_THEME, true), light = resolveTheme(DEFAULT_THEME, false);
    expect(dark.mode).toBe("dark");
    expect(dark.palette).toEqual(DEFAULT_THEME.paletteDark);
    expect(light.mode).toBe("light");
    expect(light.palette).toEqual(DEFAULT_THEME.paletteLight);
    expect(themeVars(light)["--color-scheme"]).toBe("light");
    expect(themeVars(light)["--surface"]).toBe(PRESETS[1].palette.surface);
  });
  it("withMode switches sides from the pair and fills a missing side for system", () => {
    expect(withMode(PRESETS[1], "dark", false, PRESETS[0] as Required<Theme>).palette).toEqual(PRESETS[0].palette);
    const custom = parseTheme(V1_LIGHT).theme!; // no pair
    const fallback = { paletteDark: PRESETS[3].paletteDark!, paletteLight: PRESETS[3].paletteLight! };
    const sys = withMode(custom, "system", true, fallback);
    expect(parseTheme(sys).theme).toBeDefined();
    expect(sys.paletteLight).toEqual(custom.palette); // the side on screen is kept
    expect(sys.paletteDark).toEqual(fallback.paletteDark);
    expect(sys.palette).toEqual(fallback.paletteDark); // system is dark: that side is current
  });
  it("withPalette edits the side on screen and leaves the other alone", () => {
    const t = withPalette(DEFAULT_THEME, { accent: "#112233" }, false);
    expect(t.paletteLight!.accent).toBe("#112233");
    expect(t.paletteDark).toEqual(DEFAULT_THEME.paletteDark);
    expect(resolveTheme(t, false).palette.accent).toBe("#112233");
    const plain = withPalette(parseTheme(V1_DARK).theme!, { text: "#FFFFFF" }, false);
    expect(plain.palette.text).toBe("#FFFFFF");
    expect(plain.paletteDark).toBeUndefined();
  });
});

describe("High contrast preset (WCAG AAA)", () => {
  for (const dark of [true, false]) {
    const t = resolveTheme({ ...HC, mode: "system" }, dark);
    const p = t.palette;
    const v = themeVars(t);
    // Every surface the accent can sit on: page, raised, row hover and row active.
    const all = [p.surface, p.surfaceRaised, v["--surface-hover"], v["--surface-active"]];
    it(`${t.mode}: text, secondary text and accent 7:1 on every surface, danger 4.5:1`, () => {
      expect(t.contrast).toBe("high");
      for (const s of all) {
        expect(ratio(p.text, s)).toBeGreaterThanOrEqual(7);
        expect(ratio(p.textMuted, s)).toBeGreaterThanOrEqual(7);
        expect(ratio(p.accent, s)).toBeGreaterThanOrEqual(7); // the preset's own accent, unclamped
        expect(ratio(v["--accent-fallback"], s)).toBeGreaterThanOrEqual(7);
        expect(ratio(p.danger, s)).toBeGreaterThanOrEqual(4.5);
      }
      expect(v["--accent-fallback"].toLowerCase()).toBe(p.accent.toLowerCase());
    });
    it(`${t.mode}: any album-art accent is clamped to stay AAA on every surface`, () => {
      let seed = 11;
      const rnd = () => { seed = (seed * 48271) % 2147483647; return (seed % 256).toString(16).padStart(2, "0"); };
      for (let i = 0; i < 300; i++) {
        const raw = `#${rnd()}${rnd()}${rnd()}`;
        const fit = fitPalette({ accent: raw, ambient1: raw, ambient2: raw }, accentSurface(t), accentRatio(t));
        for (const s of all) expect(ratio(fit.accent, s)).toBeGreaterThanOrEqual(7 - 1e-9);
        expect(ratio(fit.accentText, fit.accent)).toBeGreaterThanOrEqual(7);
      }
    });
  }
  it("standard themes keep the 3:1 accent floor", () => {
    expect(accentRatio(PRESETS[0])).toBe(3);
    expect(accentRatio(HC)).toBe(7);
  });
});
