import type { QueryClient } from "@tanstack/react-query";
import { initMediaSession } from "./mediaSession";
import { initShortcuts } from "./shortcuts";
import { initPersistence } from "./persist";
import { loadPlaybackSettings } from "./store";
import { initAppMenu } from "../lib/appMenu";
import { initMiniBridge } from "./miniBridge";
import { initMenuBar } from "../lib/menuBar";
import { initTrackNotifications } from "../lib/notifications";

let done = false;
export function initPlayer(_qc: QueryClient) {
  if (done) return;
  done = true;
  void loadPlaybackSettings();
  initMediaSession();
  initShortcuts();
  void initPersistence();
  void initAppMenu();
  void initMiniBridge();
  void initMenuBar();
  void initTrackNotifications();
}
