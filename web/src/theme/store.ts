import { create } from "zustand";
import { DEFAULT_THEME, applyTheme, parseTheme, presetByName, type Theme } from "@bc/core";
import { getCore } from "../api/core";
import { backgroundFileUrl } from "../lib/files";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface ThemeState {
  theme: Theme;
  loaded: boolean;
  /** Name of the preset the current theme was derived from, for the Reset action. */
  basePreset: string;
  update: (patch: DeepPartial<Theme>) => void;
  replace: (theme: Theme, basePreset?: string) => void;
  applyPreset: (name: string) => void;
  reset: () => void;
}

function merge(theme: Theme, patch: DeepPartial<Theme>): Theme {
  return {
    ...theme,
    ...patch,
    palette: { ...theme.palette, ...(patch.palette ?? {}) },
    fonts: { ...theme.fonts, ...(patch.fonts ?? {}) },
    background: { ...theme.background, ...(patch.background ?? {}) },
  } as Theme;
}

let saveTimer: number | null = null;
function persist(theme: Theme, basePreset: string) {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void getCore().then((c) => c.setSetting("theme", { theme, basePreset })).catch(() => undefined);
  }, 300);
}

/** Push the theme onto :root, including the background image layer. */
async function paint(theme: Theme) {
  const root = document.documentElement;
  applyTheme(theme, root);
  let img = "none";
  if (theme.background.source === "url") img = `url("${encodeURI(theme.background.value)}")`;
  else if (theme.background.source === "file") {
    const u = await backgroundFileUrl(theme.background.value);
    img = u ? `url("${u}")` : "none";
  }
  root.style.setProperty("--bg-image", img);
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: DEFAULT_THEME,
  loaded: false,
  basePreset: DEFAULT_THEME.name,
  update: (patch) => {
    const r = parseTheme(merge(get().theme, patch));
    if (!r.theme) return; // ignore an invalid intermediate value (e.g. half-typed hex)
    set({ theme: r.theme });
    void paint(r.theme);
    persist(r.theme, get().basePreset);
  },
  replace: (theme, basePreset) => {
    const bp = basePreset ?? get().basePreset;
    set({ theme, basePreset: bp });
    void paint(theme);
    persist(theme, bp);
  },
  applyPreset: (name) => {
    const p = presetByName(name);
    if (p) get().replace(p, name);
  },
  reset: () => get().applyPreset(get().basePreset),
}));

/** Apply the default immediately (before first paint), then the saved theme once the database is open. */
export async function initTheme() {
  void paint(DEFAULT_THEME);
  await loadSavedTheme();
}

/** Read the saved theme again (after a library import replaced it) and paint it. */
export async function loadSavedTheme() {
  try {
    const core = await getCore();
    const saved = await core.getSetting<{ theme: unknown; basePreset?: string }>("theme");
    const parsed = saved ? parseTheme(saved.theme) : null;
    if (parsed?.theme) {
      useTheme.setState({ theme: parsed.theme, basePreset: saved?.basePreset ?? parsed.theme.name, loaded: true });
      void paint(parsed.theme);
    } else useTheme.setState({ loaded: true });
  } catch {
    useTheme.setState({ loaded: true });
  }
}
