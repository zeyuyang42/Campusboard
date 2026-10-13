import type { QueryClient } from "@tanstack/react-query";
import { initMediaSession } from "./mediaSession";
import { initShortcuts } from "./shortcuts";
import { initPersistence } from "./persist";

let done = false;
export function initPlayer(_qc: QueryClient) {
  if (done) return;
  done = true;
  initMediaSession();
  initShortcuts();
  void initPersistence();
}
