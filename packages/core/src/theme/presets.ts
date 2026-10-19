import type { Palette, Theme } from "./schema.js";

const base = {
  version: 1 as const,
  contrast: "standard" as const,
  radius: 10,
  density: "comfortable" as const,
  fonts: { display: "Bricolage Grotesque Variable", ui: "Instrument Sans Variable" },
  ambient: 0.6,
  background: { source: "none" as const, value: "", blur: 12, dim: 0.5 },
};

// Each preset family has a dark and a light side, so any preset can follow the system.
const P = {
  dusk: { surface: "#23262D", surfaceRaised: "#2C3038", text: "#F1EEE9", textMuted: "#9A9AA6", accent: "#5BB6D1", danger: "#E06A5E" },
  daylight: { surface: "#F5F6F8", surfaceRaised: "#FFFFFF", text: "#1E2026", textMuted: "#6B6E78", accent: "#2A7FA3", danger: "#C8473C" },
  ember: { surface: "#2A2320", surfaceRaised: "#352C28", text: "#F3EBE3", textMuted: "#A89C93", accent: "#E0905A", danger: "#E06A5E" },
  emberLight: { surface: "#F6EFE8", surfaceRaised: "#FFFAF5", text: "#2A211C", textMuted: "#76675D", accent: "#B05A24", danger: "#C0432F" },
  moss: { surface: "#1F2622", surfaceRaised: "#28312C", text: "#ECEFE8", textMuted: "#94A096", accent: "#8CC474", danger: "#E06A5E" },
  mossLight: { surface: "#EEF2EC", surfaceRaised: "#F9FBF7", text: "#1E2620", textMuted: "#5F6C63", accent: "#4A7A36", danger: "#B8432F" },
  paper: { surface: "#EFEBE3", surfaceRaised: "#F8F5EF", text: "#2B2724", textMuted: "#7A726A", accent: "#9A5A2E", danger: "#B8432F" },
  paperDark: { surface: "#26231F", surfaceRaised: "#302C27", text: "#EFEBE3", textMuted: "#A39A90", accent: "#D49A6A", danger: "#E06A5E" },
  // WCAG AAA: text and secondary text at 7:1 or more on both surfaces, accent and danger 4.5:1.
  hcDark: { surface: "#000000", surfaceRaised: "#141414", text: "#FFFFFF", textMuted: "#D4D4D4", accent: "#7CD3FF", danger: "#FF8A80" },
  hcLight: { surface: "#FFFFFF", surfaceRaised: "#F0F0F0", text: "#000000", textMuted: "#2E2E2E", accent: "#00507A", danger: "#A0140A" },
} satisfies Record<string, Palette>;

const pair = (dark: Palette, light: Palette) => ({ paletteDark: dark, paletteLight: light });

export const PRESETS: Theme[] = [
  { ...base, name: "Dusk", mode: "dark", palette: P.dusk, ...pair(P.dusk, P.daylight) },
  { ...base, name: "Daylight", mode: "light", palette: P.daylight, ...pair(P.dusk, P.daylight) },
  { ...base, name: "Ember", mode: "dark", palette: P.ember, ...pair(P.ember, P.emberLight) },
  { ...base, name: "Moss", mode: "dark", palette: P.moss, ...pair(P.moss, P.mossLight) },
  { ...base, name: "Paper", mode: "light", palette: P.paper, ...pair(P.paperDark, P.paper) },
  { ...base, name: "High contrast", mode: "dark", contrast: "high", palette: P.hcDark, ...pair(P.hcDark, P.hcLight) },
];

/** What a new library starts with: Dusk and Daylight, following the Mac's appearance. */
export const DEFAULT_THEME: Theme = { ...PRESETS[0], mode: "system" };
/** The fixed default before system themes existed, for libraries that never saved a theme. */
export const LEGACY_DEFAULT_THEME: Theme = PRESETS[0];

export function presetByName(name: string): Theme | undefined {
  return PRESETS.find((p) => p.name === name);
}
