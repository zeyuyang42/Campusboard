import { accentRatio, type ResolvedTheme } from "./schema.js";
import { hexToRgb, rgbToHex, mix, ensureContrast, contrast } from "./color.js";

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

/** The hover and active row tints: the raised surface mixed toward the text color. */
function surfaceMixes(t: ResolvedTheme): { hover: string; active: string } {
  const raised = hexToRgb(t.palette.surfaceRaised), text = hexToRgb(t.palette.text);
  const dark = t.mode === "dark";
  return { hover: rgbToHex(mix(raised, text, dark ? 0.06 : 0.05)), active: rgbToHex(mix(raised, text, dark ? 0.11 : 0.09)) };
}

/**
 * The surface the accent is clamped against. Standard: the page surface (3:1). High contrast:
 * the worst of surface, raised, hover and active (the one nearest the text), so 7:1 holds on all.
 */
export function accentSurface(t: ResolvedTheme): string {
  if (t.contrast !== "high") return t.palette.surface;
  const { hover, active } = surfaceMixes(t);
  const text = hexToRgb(t.palette.text);
  return [t.palette.surface, t.palette.surfaceRaised, hover, active]
    .reduce((worst, s) => (contrast(hexToRgb(s), text) < contrast(hexToRgb(worst), text) ? s : worst));
}

/** Compute every CSS custom property the stylesheet reads from a theme. Pure, testable. */
export function themeVars(t: ResolvedTheme): ThemeVars {
  const dark = t.mode === "dark";
  const high = t.contrast === "high";
  const { hover, active } = surfaceMixes(t);
  const accent = ensureContrast(hexToRgb(t.palette.accent), hexToRgb(accentSurface(t)), accentRatio(t));
  const compact = t.density === "compact";
  const b = t.backdrop;
  const conservative = b.mode === "conservative";
  return {
    "--surface": t.palette.surface,
    "--surface-raised": t.palette.surfaceRaised,
    "--surface-hover": hover,
    "--surface-active": active,
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
    "--ambient-strength": String(conservative ? t.ambient : b.intensity),
    "--bg-blur": `${t.background.blur}px`,
    "--bg-dim": String(t.background.dim),
    "--color-scheme": t.mode,
    ...backdropVars(t),
  };
}

/** The panels never go below this opacity, so text keeps its contrast over any art (#110). */
export const PANEL_ALPHA_FLOOR = 0.68;

/**
 * The frosted-panel variables (#110). Conservative: opaque panels, no blur, no tint, exactly
 * the look before the backdrop existed. Otherwise the panels let `0.22 + 0.1·intensity` of the
 * backdrop through (floored at PANEL_ALPHA_FLOOR), blur it and take a light tint of the art.
 */
export function backdropVars(t: Pick<ResolvedTheme, "backdrop">): ThemeVars {
  const b = t.backdrop;
  const conservative = b.mode === "conservative";
  const alpha = conservative ? 1 : Math.max(PANEL_ALPHA_FLOOR, 0.78 - 0.1 * b.intensity);
  return {
    "--backdrop-intensity": String(b.intensity),
    "--panel-alpha": String(Math.round(alpha * 1000) / 1000),
    "--panel-blur": conservative ? "0px" : "28px",
    "--panel-tint": conservative ? "0" : "0.04",
  };
}

/** Write a resolved theme (see resolveTheme) onto an element. Only setProperty, never string CSS. */
export function applyTheme(t: ResolvedTheme, root: { style: { setProperty(name: string, value: string): void }; dataset?: DOMStringMap }): void {
  const vars = themeVars(t);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  if (root.dataset) {
    root.dataset.theme = t.mode;
    // The stylesheet scopes every frosted-panel rule under :not([data-backdrop="conservative"]).
    root.dataset.backdrop = t.backdrop.mode;
  }
}
