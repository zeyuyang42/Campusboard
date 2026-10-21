// Main-window side of the mini player (web/src/mini/). The mini window has no audio and no
// core: this module broadcasts a compact state to it (on change, plus a 1 s position tick
// while playing) and maps its commands to player store actions, so the store stays the only
// owner of the audio element and Now Playing keeps following it. Works with this window
// hidden: closing it only hides it and its page keeps running.
import { buildMiniState, MINI_EVENTS, miniLiveAfter, MiniStateThrottle, parseMiniCommand, toggleAction, type MiniCommand, type ToggleAction } from "@bc/core";
import { elementPaused, usePlayer } from "./store";
import { useTheme } from "../theme/store";
import { appliedPalette, onPaletteChange } from "../theme/usePalette";
import { currentSwatches, onSwatchesChange } from "../backdrop/swatches";
import { createBus, type MiniBus } from "../mini/bus";
import { isTauri } from "../lib/env";

interface ToggleRecord { status: string; wantsPlay: boolean; paused: boolean }
const info = {
  live: false, hellos: 0, byes: 0, sent: 0, commands: 0, rejected: 0, lastCommand: null as string | null,
  /** The last toggle: the state it saw, what it decided and the state right after (selftest). */
  lastToggle: null as { before: ToggleRecord; decision: ToggleAction; after: ToggleRecord } | null,
};
/** Counters for the selftest. */
export const miniBridgeInfo = () => ({ ...info });

const record = (): ToggleRecord => {
  const s = usePlayer.getState();
  return { status: s.status, wantsPlay: s.wantsPlay, paused: elementPaused() };
};

async function showMain() {
  if (!isTauri) { window.focus(); return; }
  // Through Rust's reveal(), which also cancels a hide still waiting on full screen.
  const { invoke } = await import("@tauri-apps/api/core");
  if (await invoke("show_main_window").then(() => true, () => false)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.unminimize().catch(() => undefined);
  await w.show().catch(() => undefined);
  await w.setFocus().catch(() => undefined);
}

function run(cmd: MiniCommand, sendNow: () => void) {
  const p = usePlayer.getState();
  switch (cmd.type) {
    case "hello": info.hellos++; sendNow(); return;
    case "bye": info.byes++; return;
    case "toggle": {
      const before = record();
      const decision = toggleAction(p.status, p.wantsPlay);
      p.toggle();
      info.lastToggle = { before, decision, after: record() };
      return;
    }
    case "play": p.play(); return;
    case "pause": p.pause(); return;
    case "next": p.next(); return;
    case "prev": p.prev(); return;
    case "seek": if (p.current()) p.seek(cmd.sec); return;
    case "showMain": void showMain(); return;
  }
}

/** Open the mini player, or hide it when it is showing (Window > Mini Player does the same). */
export async function toggleMiniPlayer() {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("toggle_mini_player");
  } else {
    // Browser mode: a popup speaking the same protocol over BroadcastChannel.
    window.open("/mini.html", "bc-mini", "popup,width=340,height=100");
  }
}

let started = false;
export async function initMiniBridge() {
  if (started) return;
  started = true;
  let bus: MiniBus;
  try { bus = await createBus("mini"); } catch { return; }
  const throttle = new MiniStateThrottle(1000);
  /** The fitted palette plus the boosted swatches (#110) for the mini window's gradient. */
  const palette = () => {
    const p = appliedPalette();
    if (!p) return null;
    const swatches = currentSwatches()?.swatches.map((s) => s.hex);
    return swatches?.length ? { ...p, swatches } : p;
  };
  const current = () => buildMiniState(usePlayer.getState(), palette(), useTheme.getState().resolved);
  const push = (force: boolean) => {
    const s = current();
    if (force) throttle.reset();
    if (!throttle.next(s, performance.now())) return;
    info.sent++;
    void bus.send(MINI_EVENTS.state, s).catch(() => undefined);
  };
  await bus.on(MINI_EVENTS.command, (payload) => {
    const cmd = parseMiniCommand(payload);
    if (!cmd) { info.rejected++; return; }
    info.commands++;
    info.lastCommand = cmd.type;
    info.live = miniLiveAfter(info.live, cmd);
    run(cmd, () => push(true));
  });
  // Only while the mini window is showing: hello (opened, shown) starts it, bye (hidden,
  // from the page or from Rust) stops it.
  const live = () => info.live;
  usePlayer.subscribe(() => { if (live()) push(false); });
  useTheme.subscribe(() => { if (live()) push(false); });
  onPaletteChange(() => { if (live()) push(false); });
  onSwatchesChange(() => { if (live()) push(false); });
}
