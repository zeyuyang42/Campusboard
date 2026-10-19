import { accentRatio, type ResolvedTheme } from "./schema.js";
import { hexToRgb, rgbToHex, mix, ensureContrast } from "./color.js";

const BUNDLED = { display: "Bricolage Grotesque Variable", ui: "Instrument Sans Variable" };

/** A font-family stack that always ends in the bundled faces, so unknown names degrade gracefully. */
export function fontStack(family: string, role: "display" | "ui"): string {
  const clean = family.trim().replace(/["\\]/g, "");
  const parts = clean ? [`"${clean}"`] : [];
  if (clean !== BUNDLED[role]) parts.push(`"${BUNDLED[role]}"`);
  parts.push("ui-sans-serif", "system-ui", "sans-serif");
  return parts.join(", ");
}

export interface ThemeVars { [name: string]: string }

/** Compute every CSS custom property the stylesheet reads from a theme. Pure, testable. */
export function themeVars(t: ResolvedTheme): ThemeVars {
  const surface = hexToRgb(t.palette.surface);
  const raised = hexToRgb(t.palette.surfaceRaised);
  const text = hexToRgb(t.palette.text);
  const dark = t.mode === "dark";
  const high = t.contrast === "high";
  const accent = ensureContrast(hexToRgb(t.palette.accent), surface, accentRatio(t));
  const compact = t.density === "compact";
  return {
    "--surface": t.palette.surface,
    "--surface-raised": t.palette.surfaceRaised,
    "--surface-hover": rgbToHex(mix(raised, text, dark ? 0.06 : 0.05)),
    "--surface-active": rgbToHex(mix(raised, text, dark ? 0.11 : 0.09)),
    "--line": dark ? `rgba(255,255,255,${high ? 0.3 : 0.08})` : `rgba(0,0,0,${high ? 0.3 : 0.08})`,
    "--text": t.palette.text,
    "--text-muted": t.palette.textMuted,
    "--accent-fallback": rgbToHex(accent),
    "--danger": t.palette.danger,
    "--radius": `${t.radius}px`,
    "--radius-sm": `${Math.max(2, Math.round(t.radius * 0.6))}px`,
    "--radius-lg": `${Math.round(t.radius * 1.2)}px`,
    "--row-h": compact ? "36px" : "48px",
    "--card-gap": compact ? "16px" : "22px",
    "--pad-page": compact ? "24px" : "32px",
    "--font-display": fontStack(t.fonts.display, "display"),
    "--font-ui": fontStack(t.fonts.ui, "ui"),
    "--ambient-strength": String(t.ambient),
    "--bg-blur": `${t.background.blur}px`,
    "--bg-dim": String(t.background.dim),
    "--color-scheme": t.mode,
  };
}

/** Write a resolved theme (see resolveTheme) onto an element. Only setProperty, never string CSS. */
export function applyTheme(t: ResolvedTheme, root: { style: { setProperty(name: string, value: string): void }; dataset?: DOMStringMap }): void {
  const vars = themeVars(t);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  if (root.dataset) root.dataset.theme = t.mode;
}
