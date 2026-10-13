import { usePlayer } from "./store";
import { artUrl } from "../lib/art";
import { audioEl } from "./audio";

export function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const api = usePlayer.getState();
  ms.setActionHandler("play", () => api.play());
  ms.setActionHandler("pause", () => api.pause());
  ms.setActionHandler("previoustrack", () => usePlayer.getState().prev());
  ms.setActionHandler("nexttrack", () => usePlayer.getState().next());
  try {
    ms.setActionHandler("seekto", (d) => { if (d.seekTime != null) usePlayer.getState().seek(d.seekTime); });
    ms.setActionHandler("seekbackward", (d) => usePlayer.getState().seekBy(-(d.seekOffset ?? 10)));
    ms.setActionHandler("seekforward", (d) => usePlayer.getState().seekBy(d.seekOffset ?? 10));
  } catch { /* unsupported */ }

  let lastId: number | null = null;
  usePlayer.subscribe((s) => {
    const cur = s.queue[s.index];
    if (cur && cur.id !== lastId) {
      lastId = cur.id;
      const art = artUrl(cur.art_id, 10);
      ms.metadata = new MediaMetadata({
        title: cur.title,
        artist: cur.track_artist ?? cur.artist_name,
        album: cur.album_title,
        artwork: art ? [{ src: art, sizes: "1200x1200", type: "image/jpeg" }] : [],
      });
    }
    ms.playbackState = s.status === "playing" ? "playing" : s.status === "paused" ? "paused" : "none";
    if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
      try {
        ms.setPositionState({ duration: audioEl.duration, playbackRate: 1, position: Math.min(audioEl.currentTime, audioEl.duration) });
      } catch { /* ignore */ }
    }
  });
}
