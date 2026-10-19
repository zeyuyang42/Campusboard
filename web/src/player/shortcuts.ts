import { VOLUME_STEP } from "@bc/core";
import { usePlayer } from "./store";
import { useUi } from "../ui/store";
import { focusFind } from "../lib/navigation";
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
    const p = usePlayer.getState();
    switch (e.key) {
      case " ": e.preventDefault(); p.toggle(); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey ? p.next() : p.seekBy(5); break;
      case "ArrowLeft": e.preventDefault(); e.shiftKey ? p.prev() : p.seekBy(-5); break;
      case "ArrowUp": e.preventDefault(); p.stepVolume(VOLUME_STEP); break;
      case "ArrowDown": e.preventDefault(); p.stepVolume(-VOLUME_STEP); break;
      case "s": case "S": p.toggleShuffle(); break;
      case "r": case "R": p.cycleRepeat(); break;
      case "q": case "Q": p.setQueueOpen(!p.queueOpen); break;
      case "n": case "N": if (p.current()) useUi.getState().setNowPlayingOpen(!useUi.getState().nowPlayingOpen); break;
      case "/": e.preventDefault(); focusFind(); break;
      case "Escape": if (useUi.getState().nowPlayingOpen) useUi.getState().setNowPlayingOpen(false); else p.setQueueOpen(false); break;
    }
  });
}
