import { usePlayer } from "./store";
import { useUi } from "../ui/store";
import { focusSearch } from "../lib/navigation";

export function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const p = usePlayer.getState();
    switch (e.key) {
      case " ": e.preventDefault(); p.toggle(); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey ? p.next() : p.seekBy(5); break;
      case "ArrowLeft": e.preventDefault(); e.shiftKey ? p.prev() : p.seekBy(-5); break;
      case "ArrowUp": e.preventDefault(); p.setVolume(p.volume + 0.05); break;
      case "ArrowDown": e.preventDefault(); p.setVolume(p.volume - 0.05); break;
      case "s": case "S": p.toggleShuffle(); break;
      case "r": case "R": p.cycleRepeat(); break;
      case "q": case "Q": p.setQueueOpen(!p.queueOpen); break;
      case "n": case "N": if (p.current()) useUi.getState().setNowPlayingOpen(!useUi.getState().nowPlayingOpen); break;
      case "/": e.preventDefault(); focusSearch(); break;
      case "Escape": if (useUi.getState().nowPlayingOpen) useUi.getState().setNowPlayingOpen(false); else p.setQueueOpen(false); break;
    }
  });
}
