import { loadPlayState, savePlayState } from "../api/queries";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayer } from "./store";
import { audioEl } from "./audio";
import type { PlayState } from "@bc/core";

function snapshot(): PlayState {
  const s = usePlayer.getState();
  return {
    current_track_id: s.queue[s.index]?.id ?? null,
    position_sec: audioEl.currentTime || s.position || 0,
    queue: s.queue,
    queue_index: s.index,
    shuffle: s.shuffle,
    repeat: s.repeat,
    volume: s.volume,
  };
}

export async function initPersistence() {
  try {
    const st = await loadPlayState();
    usePlayer.getState().hydrate({ queue: st.queue, index: st.queue_index, position: st.position_sec, volume: st.volume, shuffle: st.shuffle, repeat: st.repeat });
  } catch (e) {
    console.warn("could not restore play state", e);
  }

  let timer: number | null = null;
  const save = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void savePlayState(snapshot()).catch(() => undefined), 400);
  };

  let prev = usePlayer.getState();
  usePlayer.subscribe((s) => {
    const trackChanged = s.queue[s.index]?.id !== prev.queue[prev.index]?.id;
    const structural = s.queue !== prev.queue || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.volume !== prev.volume;
    const paused = s.status === "paused" && prev.status !== "paused";
    prev = s;
    if (trackChanged || structural || paused) save();
  });
  window.setInterval(() => { if (usePlayer.getState().status === "playing") save(); }, 5000);
  // Closing the window hides it and playback continues (Cmd+Q quits, as in
  // Music.app). Flush first so the position survives either way.
  try {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (timer) window.clearTimeout(timer);
      await savePlayState(snapshot()).catch(() => undefined);
      await win.hide().catch(() => undefined);
    });
  } catch { /* not inside Tauri */ }
}
