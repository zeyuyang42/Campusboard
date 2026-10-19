import { create } from "zustand";
import {
  DEFAULT_THEME, LEGACY_DEFAULT_THEME, applyTheme, parseTheme, presetByName, resolveTheme, withMode, withPalette,
  type Palette, type ResolvedTheme, type Theme,
} from "@bc/core";
import { getCore } from "../api/core";
import { backgroundFileUrl } from "../lib/files";
import { isTauri } from "../lib/env";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface ThemeState {
  theme: Theme;
  /** The theme as painted: a "system" mode settled against the Mac's appearance. */
  resolved: ResolvedTheme;
  /** Whether the system (prefers-color-scheme) is dark right now. */
  systemDark: boolean;
  loaded: boolean;
  /** Name of the preset the current theme was derived from, for the Reset action. */
  basePreset: string;
  update: (patch: DeepPartial<Theme>) => void;
  replace: (theme: Theme, basePreset?: string) => void;
  /** Show a theme read from the database without saving it back. */
  load: (theme: Theme, basePreset: string) => void;
  applyPreset: (name: string) => void;
  reset: () => void;
  setSystemDark: (dark: boolean) => void;
}

function merge(theme: Theme, patch: DeepPartial<Theme>): Theme {
  return {
    ...theme,
    ...patch,
    fonts: { ...theme.fonts, ...(patch.fonts ?? {}) },
    background: { ...theme.background, ...(patch.background ?? {}) },
  } as Theme;
}

const PREFERS_DARK = "(prefers-color-scheme: dark)";
function prefersDark(): boolean {
  try { return window.matchMedia?.(PREFERS_DARK).matches ?? true; } catch { return true; }
}

/** The light and dark palettes of a preset family, for a theme that lacks one side. */
function familyPair(name: string) {
  const p = presetByName(name) ?? DEFAULT_THEME;
  return { paletteDark: p.paletteDark ?? p.palette, paletteLight: p.paletteLight ?? p.palette };
}

let saveTimer: number | null = null;
function persist(theme: Theme, basePreset: string) {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void getCore().then((c) => c.setSetting("theme", { theme, basePreset })).catch(() => undefined);
  }, 300);
}

/** The title bar and traffic lights: follow the system for "system", else pin the appearance. */
let nativeMode: Theme["mode"] | null = null;
async function setNativeAppearance(mode: Theme["mode"]) {
  if (!isTauri || mode === nativeMode) return;
  nativeMode = mode;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(mode === "system" ? null : mode).catch(() => undefined);
}

/** Push the theme onto :root, including the background image layer. */
let paints = 0;
async function paint(theme: ResolvedTheme) {
  const root = document.documentElement;
  const mine = ++paints;
  applyTheme(theme, root);
  let img = "none";
  if (theme.background.source === "url") img = `url("${encodeURI(theme.background.value)}")`;
  else if (theme.background.source === "file") {
    const u = await backgroundFileUrl(theme.background.value);
    img = u ? `url("${u}")` : "none";
  }
  // A later paint (the saved theme after the early one) owns the background now.
  if (mine !== paints) return;
  root.style.setProperty("--bg-image", img);
}

export const useTheme = create<ThemeState>((set, get) => {
  /** Make `theme` current: settle it, paint it and (unless loading) save it. */
  const commit = (theme: Theme, basePreset: string, save = true) => {
    const resolved = resolveTheme(theme, get().systemDark);
    set({ theme, resolved, basePreset });
    void paint(resolved);
    void setNativeAppearance(theme.mode);
    rememberTheme(theme);
    if (save) persist(theme, basePreset);
  };
  const systemDark = prefersDark();
  return {
    theme: DEFAULT_THEME,
    resolved: resolveTheme(DEFAULT_THEME, systemDark),
    systemDark,
    loaded: false,
    basePreset: DEFAULT_THEME.name,
    update: (patch) => {
      const { mode, palette, ...rest } = patch;
      const { systemDark: dark, basePreset } = get();
      let t = get().theme;
      if (palette) t = withPalette(t, palette as Partial<Palette>, dark);
      t = merge(t, rest);
      if (mode && mode !== t.mode) t = withMode(t, mode, dark, familyPair(basePreset));
      const r = parseTheme(t);
      if (!r.theme) return; // ignore an invalid intermediate value (e.g. half-typed hex)
      commit(r.theme, basePreset);
    },
    replace: (theme, basePreset) => commit(theme, basePreset ?? get().basePreset),
    load: (theme, basePreset) => commit(theme, basePreset, false),
    applyPreset: (name) => {
      const p = presetByName(name);
      if (!p) return;
      // A theme following the system keeps following it with the new colors.
      const keepSystem = get().theme.mode === "system";
      get().replace(keepSystem ? withMode(p, "system", get().systemDark, familyPair(name)) : p, name);
    },
    reset: () => get().applyPreset(get().basePreset),
    setSystemDark: (dark) => {
      if (dark === get().systemDark) return;
      const resolved = resolveTheme(get().theme, dark);
      set({ systemDark: dark, resolved });
      if (get().theme.mode === "system") void paint(resolved);
    },
  };
});

/** Follow prefers-color-scheme live (macOS appearance changes). Returns an unsubscribe function. */
export function watchSystemAppearance(win: Pick<Window, "matchMedia"> = window): () => void {
  let mql: MediaQueryList | undefined;
  try { mql = win.matchMedia?.(PREFERS_DARK); } catch { /* no media queries: stay as is */ }
  if (!mql) return () => undefined;
  const q = mql;
  const on = () => useTheme.getState().setSystemDark(q.matches);
  on();
  q.addEventListener("change", on);
  return () => q.removeEventListener("change", on);
}

/** The theme last shown in this window, so the first paint matches it before the database opens. */
const LAST_THEME_KEY = "bc.theme.last";
function rememberTheme(theme: Theme) {
  try { localStorage.setItem(LAST_THEME_KEY, JSON.stringify(theme)); } catch { /* a per-viewer convenience only */ }
}
function lastTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(LAST_THEME_KEY);
    // Validated like any theme file: it only ever reaches setProperty.
    return raw ? parseTheme(JSON.parse(raw)).theme ?? null : null;
  } catch { return null; }
}

/**
 * Paint the theme last shown (or the default) at once, then the saved one once the database is
 * open. The native title bar waits for the saved theme, so it doesn't flip on launch.
 */
export async function initTheme() {
  watchSystemAppearance();
  const s = useTheme.getState();
  const last = lastTheme();
  void paint(last ? resolveTheme(last, s.systemDark) : s.resolved);
  await loadSavedTheme();
}

/** Read the saved theme again (after a library import replaced it) and paint it. */
export async function loadSavedTheme() {
  try {
    const core = await getCore();
    const saved = await core.getSetting<{ theme: unknown; basePreset?: string }>("theme");
    const parsed = saved ? parseTheme(saved.theme) : null;
    const { load } = useTheme.getState();
    if (parsed?.theme) load(parsed.theme, saved?.basePreset ?? parsed.theme.name);
    else if (saved) load(DEFAULT_THEME, DEFAULT_THEME.name); // unreadable: show the default, keep the file
    else {
      // Nothing saved: a new library saves the system default once, so "nothing saved" only ever
      // means a library from before system themes; one with plays keeps the old fixed default.
      const plays = await core.playCount().catch(() => null);
      const t = plays ? LEGACY_DEFAULT_THEME : DEFAULT_THEME;
      if (plays != null) await core.setSetting("theme", { theme: t, basePreset: t.name });
      load(t, t.name);
    }
  } catch {
    /* the database isn't readable: keep what is painted */
  }
  useTheme.setState({ loaded: true });
}
