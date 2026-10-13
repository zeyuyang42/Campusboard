import { z } from "zod";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colors must be 6-digit hex like #23262D");
const FontName = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9 ,'\-]+$/, "Font names may only contain letters, digits, spaces, commas, apostrophes and hyphens");

export const ThemeSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(40),
  mode: z.enum(["dark", "light"]),
  palette: z.object({
    surface: Hex,
    surfaceRaised: Hex,
    text: Hex,
    textMuted: Hex,
    accent: Hex,
    danger: Hex,
  }),
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
    .default({ source: "none", value: "", blur: 12, dim: 0.5 }),
});

export type Theme = z.infer<typeof ThemeSchema>;

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
