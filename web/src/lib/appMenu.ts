// Bridge from the native menu bar (src-tauri/src/menu.rs) to app actions.
// Rust emits a `menu` event whose payload is the item id.
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
  "volume-up": () => { const p = usePlayer.getState(); p.setVolume(p.volume + 0.05); },
  "volume-down": () => { const p = usePlayer.getState(); p.setVolume(p.volume - 0.05); },
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

export async function initAppMenu() {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("menu", (e) => { runMenuAction(e.payload); });
}
