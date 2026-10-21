// The command palette's static actions (#72). Each one is something the app can already do
// from a menu, a button or a shortcut; the palette only gives it a name to type.
import type { SleepChoice, Theme } from "@bc/core";
import { usePlayer } from "../player/store";
import { toggleMiniPlayer } from "../player/miniBridge";
import { useTheme } from "../theme/store";
import { navigateTo } from "./navigation";

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra words it answers to. */
  keywords?: string;
  /** True when it takes the user to another page (focus then stays there). */
  navigates?: boolean;
  /** `query` is the palette's text, for actions that carry it along (Search Bandcamp). */
  run: (query: string) => void;
}

const SETTINGS: [string, string, string][] = [
  ["account", "Bandcamp account", "username sync collection cookie"],
  ["library", "Library", "export backup import file"],
  ["theme", "Theme", "colors appearance font backdrop"],
  ["playback", "Playback", "gapless crossfade"],
  ["releases", "New releases", "check artists"],
  ["history", "Listening history", "plays clear"],
  ["storage", "Storage", "offline downloads space"],
  ["background", "When the window is closed", "menu bar icon notifications background"],
  ["shortcuts", "Keyboard shortcuts", "keys help"],
];

const MODES: [Theme["mode"], string][] = [["light", "Light"], ["dark", "Dark"], ["system", "Match system"]];

const SLEEP: [SleepChoice, string][] = [
  [15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "60 minutes"],
  ["track", "End of track"], ["album", "End of album"], ["off", "Off"],
];

const go = (id: string, label: string, path: string, keywords?: string): PaletteAction =>
  ({ id, label, keywords, navigates: true, run: () => navigateTo(path) });

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  { id: "play-pause", label: "Play/Pause", keywords: "pause resume", run: () => usePlayer.getState().toggle() },
  { id: "next", label: "Next track", keywords: "skip forward", run: () => usePlayer.getState().next() },
  { id: "previous", label: "Previous track", keywords: "back", run: () => usePlayer.getState().prev() },
  go("import", "Import…", "/import", "link url add"),
  {
    id: "search-bandcamp", label: "Search Bandcamp…", keywords: "find online", navigates: true,
    run: (q) => navigateTo(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : "/search"),
  },
  go("discover", "Discover", "/discover", "browse tags genre explore new"),
  { id: "mini-player", label: "Mini Player", keywords: "window small", run: () => { void toggleMiniPlayer().catch(() => undefined); } },
  go("settings", "Settings", "/settings", "preferences"),
  ...SETTINGS.map(([hash, label, kw]) => go(`settings:${hash}`, `Settings: ${label}`, `/settings#${hash}`, kw)),
  ...MODES.map(([mode, label]): PaletteAction => ({ id: `theme:${mode}`, label: `Appearance: ${label}`, keywords: "theme mode color scheme", run: () => useTheme.getState().update({ mode }) })),
  ...SLEEP.map(([c, label]): PaletteAction => ({ id: `sleep:${c}`, label: `Sleep timer: ${label}`, keywords: "stop timer", run: () => usePlayer.getState().setSleep(c) })),
];

/** Lowercase without diacritics, so "eclair" finds "Éclair". */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Every word of `query` appears somewhere in `text` (folded); an empty query matches. */
export function matches(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export const filterActions = (query: string) => PALETTE_ACTIONS.filter((a) => matches(`${a.label} ${a.keywords ?? ""}`, query));
