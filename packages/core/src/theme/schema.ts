import { z } from "zod";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colors must be 6-digit hex like #23262D");
const FontName = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9 ,'\-]+$/, "Font names may only contain letters, digits, spaces, commas, apostrophes and hyphens");

export const PaletteSchema = z.object({
  surface: Hex,
  surfaceRaised: Hex,
  text: Hex,
  textMuted: Hex,
  accent: Hex,
  danger: Hex,
});

export const BACKDROP_MODES = ["conservative", "wash", "morph"] as const;
export const BACKDROP_STYLES = ["ink", "aurora", "glitch", "lava"] as const;
/** "grain" was the 0.9.0 name of the style that became "glitch" (#113); saved themes and theme files still say it. */
const STYLE_ALIASES: Record<string, (typeof BACKDROP_STYLES)[number]> = { grain: "glitch" };
export const BackdropSchema = z.object({
  mode: z.enum(BACKDROP_MODES),
  /** The generative style, used by "morph" only (kept across mode switches). */
  style: z.preprocess((v) => (typeof v === "string" && Object.prototype.hasOwnProperty.call(STYLE_ALIASES, v) ? STYLE_ALIASES[v] : v), z.enum(BACKDROP_STYLES)),
  /** How much of the surface the art colours take: 0 is the bare surface, 1 is full colour. */
  intensity: z.number().min(0).max(1),
  /** "still": no drift at all, only the cross-fade on a track change. */
  motion: z.enum(["drift", "still"]),
});
export type Backdrop = z.infer<typeof BackdropSchema>;
export const DEFAULT_BACKDROP: Backdrop = { mode: "morph", style: "ink", intensity: 1, motion: "drift" };

export const ThemeSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(40),
  /** "system" follows the Mac's appearance and needs both paletteDark and paletteLight. */
  mode: z.enum(["dark", "light", "system"]),
  /** The palette of a dark or light theme. For "system", a copy of the side last picked or edited. */
  palette: PaletteSchema,
  /** Optional light/dark pair, kept across mode switches so "system" always has both sides. */
  paletteDark: PaletteSchema.optional(),
  paletteLight: PaletteSchema.optional(),
  /** "high" holds the art-derived accent to WCAG AAA (7:1) against the surface. */
  contrast: z.enum(["standard", "high"]).default("standard"),
  radius: z.number().min(0).max(24),
  density: z.enum(["comfortable", "compact"]),
  fonts: z.object({ display: FontName, ui: FontName }),
  /** 0 turns the album-art wash off, 1 is strongest. */
  ambient: z.number().min(0).max(1),
  background: z
    .object({
      source: z.enum(["none", "file", "url"]),
      /** For "url": an https URL. For "file": a file name inside the app's backgrounds folder. */
      value: z.string().max(512),
      blur: z.number().min(0).max(40),
      dim: z.number().min(0).max(1),
    })
    // A file background names one file in the backgrounds folder: no folders, no "..".
    .refine((b) => b.source !== "file" || b.value === "" || /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(b.value), {
      message: "a background file must be a plain file name", path: ["value"],
    })
    .default({ source: "none", value: "", blur: 12, dim: 0.5 }),
  /**
   * The album-art backdrop (#110). "conservative" is the look before it: the two corner washes
   * at `ambient` strength and opaque panels. "wash" drifts those washes in CSS; "morph" paints
   * a generative canvas in one of four styles. Additive with a default, so older saved themes
   * and theme files still parse (version stays 1); so does the renamed style (STYLE_ALIASES).
   */
  backdrop: BackdropSchema.default(DEFAULT_BACKDROP),
}).refine((t) => t.mode !== "system" || (t.paletteDark && t.paletteLight), {
  message: "a system theme needs both paletteDark and paletteLight", path: ["mode"],
});

export type Theme = z.infer<typeof ThemeSchema>;
export type Palette = z.infer<typeof PaletteSchema>;
export type Appearance = "dark" | "light";
/** A theme settled to one appearance: what applyTheme paints and the mini window receives. */
export type ResolvedTheme = Theme & { mode: Appearance };

/** Settle a theme for the current system appearance. Pure: mode + appearance in, palette out. */
export function resolveTheme(t: Theme, systemDark: boolean): ResolvedTheme {
  if (t.mode !== "system") return t as ResolvedTheme;
  const mode: Appearance = systemDark ? "dark" : "light";
  const palette = (mode === "dark" ? t.paletteDark : t.paletteLight) ?? t.palette;
  return { ...t, mode, palette };
}

type Pair = Pick<Theme, "paletteDark" | "paletteLight">;

/**
 * Switch a theme's mode. A stored pair supplies the new side's palette; a side the theme
 * lacks comes from the palette on screen (same appearance) or `fallback` (the other one).
 */
export function withMode(t: Theme, mode: Theme["mode"], systemDark: boolean, fallback: Required<Pair>): Theme {
  const shown = resolveTheme(t, systemDark);
  const paletteDark = t.paletteDark ?? (shown.mode === "dark" ? shown.palette : fallback.paletteDark);
  const paletteLight = t.paletteLight ?? (shown.mode === "light" ? shown.palette : fallback.paletteLight);
  const dark = mode === "system" ? systemDark : mode === "dark";
  return { ...t, mode, paletteDark, paletteLight, palette: dark ? paletteDark : paletteLight };
}

/** Edit the colors on screen: `palette`, plus the matching side of the pair when there is one. */
export function withPalette(t: Theme, patch: Partial<Palette>, systemDark: boolean): Theme {
  const shown = resolveTheme(t, systemDark);
  const palette = { ...shown.palette, ...patch };
  const side = shown.mode === "dark" ? "paletteDark" : "paletteLight";
  return { ...t, palette, ...(t[side] ? { [side]: palette } : {}) };
}

/**
 * A system theme as the dark or light theme its `palette` holds (pair kept), which builds
 * before system themes accept. `followSystem` turns it back into a system theme.
 */
export function toPortable(t: Theme): Theme {
  if (t.mode !== "system") return t;
  return { ...t, mode: JSON.stringify(t.palette) === JSON.stringify(t.paletteLight) ? "light" : "dark" };
}
export function followSystem(t: Theme): Theme {
  return t.paletteDark && t.paletteLight ? { ...t, mode: "system" } : t;
}

/** Minimum accent contrast against the surface: AAA (7:1) for high contrast, 3:1 (UI) otherwise. */
export const accentRatio = (t: Pick<Theme, "contrast">): number => (t.contrast === "high" ? 7 : 3);

export interface ThemeParseResult {
  theme?: Theme;
  error?: string;
}

/** Parse a theme file. Unknown keys are dropped; a newer version is refused with a clear message. */
export function parseTheme(input: unknown): ThemeParseResult {
  if (typeof input === "object" && input && "version" in input && (input as { version: unknown }).version !== 1) {
    return { error: "This theme file was made by a newer version of the app." };
  }
  const r = ThemeSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { error: `${issue?.path.join(".") || "theme"}: ${issue?.message ?? "invalid"}` };
  }
  if (r.data.background.source === "url" && !/^https:\/\//.test(r.data.background.value)) {
    return { error: "background.value: only https:// image URLs are allowed" };
  }
  return { theme: r.data };
}

export function parseThemeJson(text: string): ThemeParseResult {
  try {
    return parseTheme(JSON.parse(text));
  } catch {
    return { error: "Not a valid JSON file." };
  }
}
