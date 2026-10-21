import { usePlayer } from "./store";
import { useUi } from "../ui/store";
import { runMenuAction } from "../lib/appMenu";
import { isTauri } from "../lib/env";
import { openPalette } from "../ui/palette";

/** ⌘K (Ctrl+K off the Mac), nothing else held. */
export const isPaletteKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";

export function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    // ⌘K is the native View → Command Palette item in the app (menu.rs). A browser has no
    // native menu, so it is caught here, unless something focused already handled ⌘K itself.
    if (isPaletteKey(e) && !isTauri && !e.defaultPrevented) { e.preventDefault(); openPalette(); return; }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Plain keys run the same actions as the menu bar's items (appMenu.ts); seeking and Escape are web-only.
    const p = usePlayer.getState();
    switch (e.key) {
      case " ": e.preventDefault(); runMenuAction("play-pause"); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey ? runMenuAction("next") : p.seekBy(5); break;
      case "ArrowLeft": e.preventDefault(); e.shiftKey ? runMenuAction("previous") : p.seekBy(-5); break;
      case "ArrowUp": e.preventDefault(); runMenuAction("volume-up"); break;
      case "ArrowDown": e.preventDefault(); runMenuAction("volume-down"); break;
      case "s": case "S": runMenuAction("shuffle"); break;
      case "r": case "R": runMenuAction("repeat"); break;
      case "q": case "Q": runMenuAction("queue"); break;
      case "n": case "N": runMenuAction("now-playing"); break;
      case "/": e.preventDefault(); runMenuAction("find"); break;
      case "Escape": if (useUi.getState().nowPlayingOpen) useUi.getState().setNowPlayingOpen(false); else p.setQueueOpen(false); break;
    }
  });
}
