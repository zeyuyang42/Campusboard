// Bridge from the native menu bar (src-tauri/src/menu.rs) to app actions.
// Rust runs window.__bcMenu(<item id>) in the main webview (see initAppMenu).
import { VOLUME_STEP } from "@bc/core";
import { isTauri } from "./env";
import { usePlayer } from "../player/store";
import { useUi } from "../ui/store";
import { focusFind, navigateTo } from "./navigation";

const actions: Record<string, () => void> = {
  "settings": () => navigateTo("/settings"),
  "import": () => navigateTo("/import"),
  "new-playlist": () => { navigateTo("/playlists"); useUi.getState().setCreatingPlaylist(true); },
  "find": () => focusFind(),
  "nav:library": () => navigateTo("/library"),
  "nav:search": () => navigateTo("/search"),
  "nav:import": () => navigateTo("/import"),
  "nav:playlists": () => navigateTo("/playlists"),
  "back": () => navigateTo(-1),
  "forward": () => navigateTo(1),
  "now-playing": () => { const ui = useUi.getState(); if (usePlayer.getState().current()) ui.setNowPlayingOpen(!ui.nowPlayingOpen); },
  "queue": () => { const p = usePlayer.getState(); p.setQueueOpen(!p.queueOpen); },
  "play-pause": () => usePlayer.getState().toggle(),
  "next": () => usePlayer.getState().next(),
  "previous": () => usePlayer.getState().prev(),
  "volume-up": () => { const p = usePlayer.getState(); p.stepVolume(VOLUME_STEP); },
  "volume-down": () => { const p = usePlayer.getState(); p.stepVolume(-VOLUME_STEP); },
  "shuffle": () => usePlayer.getState().toggleShuffle(),
  "repeat": () => usePlayer.getState().cycleRepeat(),
  "shortcuts": () => navigateTo("/settings#shortcuts"),
};

export function runMenuAction(id: string): boolean {
  const fn = actions[id];
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Rust (menu.rs `dispatch`) evaluates `window.__bcMenu(id)` in this webview. Not an event:
 * the mini window can listen to and emit any event name, so a `menu` event could be read
 * or forged from there; this function exists only in the main window's page.
 */
export async function initAppMenu() {
  if (!isTauri) return;
  (window as unknown as { __bcMenu?: (id: unknown) => void }).__bcMenu = (id) => { if (typeof id === "string") runMenuAction(id); };
}
