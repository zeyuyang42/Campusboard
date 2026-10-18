// Window chrome of the mini player: hide (its close), always on top, and the two sizes.
// Needs only the permissions in src-tauri/capabilities/mini.json. No-ops in browser mode.
import { isTauri } from "../lib/env";

/** Compact strip and the square-art layout; mini.css switches layouts on the height. */
export const COMPACT = { width: 340, height: 100 } as const;
export const TALL = { width: 300, height: 404 } as const;
/** Heights at or above this use the square-art layout (keep in step with mini.css). */
export const TALL_MIN_HEIGHT = 200;

const ON_TOP_KEY = "bc.mini.onTop";

export function savedOnTop(): boolean {
  try { return localStorage.getItem(ON_TOP_KEY) !== "0"; } catch { return true; }
}

async function win() {
  if (!isTauri) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function setOnTop(on: boolean): Promise<void> {
  try { localStorage.setItem(ON_TOP_KEY, on ? "1" : "0"); } catch { /* per-viewer convenience only */ }
  await (await win())?.setAlwaysOnTop(on);
}

export async function hideMini(): Promise<void> {
  const w = await win();
  if (w) await w.hide();
  else window.close();
}

export async function setTall(tall: boolean): Promise<void> {
  const w = await win();
  const size = tall ? TALL : COMPACT;
  if (w) {
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    await w.setSize(new LogicalSize(size.width, size.height));
  } else {
    window.resizeTo(size.width, size.height);
  }
}

/** Closing (Cmd+W) hides, like the main window; ⌘⇧M or the dock button shows it again. */
export async function initMiniWindow(): Promise<void> {
  const w = await win();
  if (!w) return;
  await w.setAlwaysOnTop(savedOnTop()).catch(() => undefined);
  await w.onCloseRequested((e) => { e.preventDefault(); void w.hide(); });
}
