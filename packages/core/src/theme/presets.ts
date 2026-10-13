import type { Theme } from "./schema.js";

const base = {
  version: 1 as const,
  radius: 10,
  density: "comfortable" as const,
  fonts: { display: "Bricolage Grotesque Variable", ui: "Instrument Sans Variable" },
  ambient: 0.6,
  background: { source: "none" as const, value: "", blur: 12, dim: 0.5 },
};

export const PRESETS: Theme[] = [
  { ...base, name: "Dusk", mode: "dark", palette: { surface: "#23262D", surfaceRaised: "#2C3038", text: "#F1EEE9", textMuted: "#9A9AA6", accent: "#5BB6D1", danger: "#E06A5E" } },
  { ...base, name: "Daylight", mode: "light", palette: { surface: "#F5F6F8", surfaceRaised: "#FFFFFF", text: "#1E2026", textMuted: "#6B6E78", accent: "#2A7FA3", danger: "#C8473C" } },
  { ...base, name: "Ember", mode: "dark", palette: { surface: "#2A2320", surfaceRaised: "#352C28", text: "#F3EBE3", textMuted: "#A89C93", accent: "#E0905A", danger: "#E06A5E" } },
  { ...base, name: "Moss", mode: "dark", palette: { surface: "#1F2622", surfaceRaised: "#28312C", text: "#ECEFE8", textMuted: "#94A096", accent: "#8CC474", danger: "#E06A5E" } },
  { ...base, name: "Paper", mode: "light", palette: { surface: "#EFEBE3", surfaceRaised: "#F8F5EF", text: "#2B2724", textMuted: "#7A726A", accent: "#9A5A2E", danger: "#B8432F" } },
];

export const DEFAULT_THEME: Theme = PRESETS[0];

export function presetByName(name: string): Theme | undefined {
  return PRESETS.find((p) => p.name === name);
}
