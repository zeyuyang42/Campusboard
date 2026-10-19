// Optional macOS notification when the track changes while the window is closed or in the
// background (tauri-plugin-notification), off by default. Called through invoke rather than
// the plugin's npm package: two commands don't need another dependency.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { QueueTrack } from "@bc/core";
import { getCore } from "../api/core";
import { isTauri } from "./env";
import { usePlayer } from "../player/store";

/** settings.key holding `true` when notifications are on. */
export const NOTIFY_SETTING_KEY = "track_notifications";

export interface NotifyInput {
  enabled: boolean;
  trackId: number | null;
  /** The track that was current before this one (null if none). */
  previousTrackId: number | null;
  /** No track has been current since launch: this is the restored or first one. */
  firstTrack: boolean;
  windowVisible: boolean;
  windowFocused: boolean;
}

/** Notify only for a real change of track that the user can't already see in the window. */
export function shouldNotify(i: NotifyInput): boolean {
  if (!i.enabled || i.trackId == null || i.firstTrack) return false;
  if (i.trackId === i.previousTrackId) return false;
  return !(i.windowVisible && i.windowFocused);
}

/** Title is the track; the body names the artist and, when it says something more, the album. */
export function notificationText(t: Pick<QueueTrack, "title" | "track_artist" | "artist_name" | "album_title">): { title: string; body: string } {
  const artist = t.track_artist || t.artist_name || "";
  const album = t.album_title && t.album_title !== t.title ? t.album_title : "";
  return { title: t.title, body: artist && album ? `${artist} — ${album}` : artist || album };
}

interface NotifyState {
  enabled: boolean;
  /** Set when turning on failed because notifications aren't allowed (not on macOS today: see setEnabled). */
  denied: boolean;
  setEnabled: (on: boolean) => Promise<void>;
}

export const useTrackNotifications = create<NotifyState>((set) => ({
  enabled: false,
  denied: false,
  setEnabled: async (on) => {
    // Permission is asked here, when the user turns it on, never at launch. On macOS the
    // plugin always answers "granted" (macOS itself controls delivery, in System Settings →
    // Notifications), so the "denied" branch only runs on mobile or if the plugin changes.
    if (on) {
      const state = await invoke<string>("plugin:notification|request_permission").catch(() => "denied");
      if (state !== "granted") { set({ enabled: false, denied: true }); return; }
    }
    set({ enabled: on, denied: false });
    void getCore().then((c) => c.setSetting(NOTIFY_SETTING_KEY, on)).catch(() => undefined);
  },
}));

async function windowState(): Promise<{ visible: boolean; focused: boolean }> {
  const w = getCurrentWindow();
  const [visible, focused] = await Promise.all([w.isVisible(), w.isFocused()]);
  return { visible, focused };
}

/** A track must stay current this long before it notifies, so holding Next posts only the last one. */
export const SETTLE_MS = 1200;

let started = false;
export async function initTrackNotifications() {
  if (started || !isTauri) return;
  started = true;
  const saved = await getCore().then((c) => c.getSetting(NOTIFY_SETTING_KEY)).catch(() => null);
  useTrackNotifications.setState({ enabled: saved === true });

  // The track the last settled change ended on. One restored before this runs counts as
  // seen, so the next change does notify.
  const s0 = usePlayer.getState();
  let settledId: number | null = s0.queue[s0.index]?.id ?? null;
  let seenTrack = settledId != null;
  let lastId = settledId;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = () => {
    timer = null;
    const s = usePlayer.getState();
    const cur = s.queue[s.index] ?? null;
    const id = cur?.id ?? null;
    const previousTrackId = settledId;
    const firstTrack = !seenTrack;
    settledId = id;
    if (id != null) seenTrack = true;
    const enabled = useTrackNotifications.getState().enabled;
    // Skip the window round trip when the answer is already no.
    if (!shouldNotify({ enabled, trackId: id, previousTrackId, firstTrack, windowVisible: false, windowFocused: false }) || !cur) return;
    void windowState().then(({ visible, focused }) => {
      if (!shouldNotify({ enabled, trackId: id, previousTrackId, firstTrack, windowVisible: visible, windowFocused: focused })) return;
      return invoke("plugin:notification|notify", { options: notificationText(cur) });
    }).catch((e) => console.warn("track notification:", e));
  };

  usePlayer.subscribe((s) => {
    const id = s.queue[s.index]?.id ?? null;
    if (id === lastId) return; // most updates are progress, volume or status
    lastId = id;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, SETTLE_MS);
  });
}
