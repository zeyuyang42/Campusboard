// Transport between the main window and the mini player window. Inside Tauri it is window
// events (emitTo the other label, listen on this webview only); in browser mode it is a
// BroadcastChannel, so the mini page can be opened as a popup and checked with Playwright.
// Payloads are untrusted on arrival: callers validate them with parseMiniState/parseMiniCommand.
import { isTauri } from "../lib/env";

export type Unlisten = () => void;

export interface MiniBus {
  send(event: string, payload: unknown): Promise<void>;
  on(event: string, cb: (payload: unknown) => void): Promise<Unlisten>;
}

const CHANNEL = "bc-mini";

/** `to`: the label of the other window ("mini" from the main window, "main" from the mini one). */
export async function createBus(to: "main" | "mini"): Promise<MiniBus> {
  if (isTauri) {
    const { emitTo } = await import("@tauri-apps/api/event");
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const self = getCurrentWebviewWindow();
    return {
      send: (event, payload) => emitTo(to, event, payload),
      on: (event, cb) => self.listen(event, (e) => cb(e.payload)),
    };
  }
  const ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  return {
    send: async (event, payload) => ch?.postMessage({ event, payload }),
    on: async (event, cb) => {
      const h = (e: MessageEvent) => { if (e.data && e.data.event === event) cb(e.data.payload); };
      ch?.addEventListener("message", h);
      return () => ch?.removeEventListener("message", h);
    },
  };
}
