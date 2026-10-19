// The optional menu-bar icon (src-tauri/src/tray.rs), off by default. This module only tells
// Rust whether to show it and which title its first row shows; its Play/Pause, Next and
// Previous items come back through window.__bcMenu (appMenu.ts) like the Controls menu.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCore } from "../api/core";
import { isTauri } from "./env";
import { usePlayer } from "../player/store";

/** settings.key holding `true` when the icon is on. */
export const MENU_BAR_SETTING_KEY = "menu_bar";

interface MenuBarState {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

export const useMenuBar = create<MenuBarState>((set) => ({
  enabled: false,
  setEnabled: (on) => {
    set({ enabled: on });
    void getCore().then((c) => c.setSetting(MENU_BAR_SETTING_KEY, on)).catch(() => undefined);
  },
}));

/** What Rust was last told; the icon doesn't exist at launch. */
let sent: { enabled: boolean; track: string | null } = { enabled: false, track: null };

function sync() {
  const enabled = useMenuBar.getState().enabled;
  const p = usePlayer.getState();
  const track = enabled ? (p.queue[p.index]?.title ?? null) : null;
  // The player store changes several times a second while playing: only a toggle or a
  // different title reaches Rust.
  if (enabled === sent.enabled && track === sent.track) return;
  sent = { enabled, track };
  invoke("set_menu_bar", { enabled, track }).catch((e) => console.warn("menu bar icon:", e));
}

/**
 * Send Rust what it was last told again: the selftest's check of the command and its grant.
 * The icon stays as the user's setting has it.
 */
export function resendMenuBar(): Promise<unknown> {
  return invoke("set_menu_bar", { ...sent });
}

let started = false;
export async function initMenuBar() {
  if (started || !isTauri) return;
  started = true;
  const saved = await getCore().then((c) => c.getSetting(MENU_BAR_SETTING_KEY)).catch(() => null);
  useMenuBar.setState({ enabled: saved === true });
  useMenuBar.subscribe(sync);
  usePlayer.subscribe(sync);
  sync();
}
