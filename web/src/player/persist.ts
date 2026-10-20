import { loadPlayState, savePlayPosition, savePlayState } from "../api/queries";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { playbackPosition, saveResumePoint, usePlayer } from "./store";
import { finishUndo } from "../ui/undo";
import { gainToPosition, positionToGain, type PlayState } from "@bc/core";

function snapshot(): PlayState {
  const s = usePlayer.getState();
  return {
    current_track_id: s.queue[s.index]?.id ?? null,
    position_sec: playbackPosition() || s.position || 0,
    queue: s.queue,
    queue_index: s.index,
    shuffle: s.shuffle,
    repeat: s.repeat,
    // Saved as the gain, as before the curve, so any build plays it at the same loudness.
    volume: positionToGain(s.volume),
  };
}

export async function initPersistence() {
  try {
    const st = await loadPlayState();
    // play_state.volume is the gain; the slider shows the position that gives it.
    const volume = gainToPosition(st.volume);
    usePlayer.getState().hydrate({ queue: st.queue, index: st.queue_index, position: st.position_sec, volume, shuffle: st.shuffle, repeat: st.repeat });
  } catch (e) {
    console.warn("could not restore play state", e);
  }

  let timer: number | null = null;
  const save = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; void savePlayState(snapshot()).catch(() => undefined); }, 400);
  };

  let prev = usePlayer.getState();
  usePlayer.subscribe((s) => {
    const trackChanged = s.queue[s.index]?.id !== prev.queue[prev.index]?.id;
    const structural = s.queue !== prev.queue || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.volume !== prev.volume;
    const paused = s.status === "paused" && prev.status !== "paused";
    prev = s;
    if (trackChanged || structural || paused) save();
  });
  // While playing only the position moves: save just that, not the whole queue (up to
  // MAX_QUEUE entries) every 5 s. Queue changes go through save() above.
  window.setInterval(() => {
    const s = usePlayer.getState();
    if (s.status !== "playing") return;
    // A long track's or episode's resume point (#85) follows the same 5 s beat, so a quit
    // (Cmd+Q, which does not wait for the page) loses at most these seconds.
    void saveResumePoint().catch(() => undefined);
    if (timer !== null) return;
    void savePlayPosition(s.queue[s.index]?.id ?? null, playbackPosition() || s.position || 0, s.index).catch(() => undefined);
  }, 5000);
  // Closing the window hides it and playback continues (Cmd+Q quits, as in
  // Music.app). Flush first so the position survives either way.
  try {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (timer) window.clearTimeout(timer);
      // The pending full save is replaced by this one; clear the handle too, or the 5 s
      // position saves (which wait while a full save is pending) would stop for good.
      timer = null;
      await savePlayState(snapshot()).catch(() => undefined);
      await saveResumePoint().catch(() => undefined);
      // A removal still offering Undo (#93) becomes final: the note goes with the window.
      await finishUndo();
      await win.hide().catch(() => undefined);
    });
  } catch { /* not inside Tauri */ }
}
