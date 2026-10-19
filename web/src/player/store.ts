import { create } from "zustand";
import { audioEventPatch, PlayCounter, swappingAfter, positionToGain, stepVolume, toggleAction, toggleMute, type AudioEventType, type CountedPlay, type QueueTrack, type RepeatMode, type Track } from "@bc/core";
import { audioEl } from "./audio";
import { getCore, invalidateQueries } from "../api/core";
import { friendlyError } from "../lib/errors";

export type Status = "idle" | "loading" | "playing" | "paused";

export interface PlayerState {
  queue: QueueTrack[];
  originalOrder: QueueTrack[] | null; // set while shuffle is on
  index: number;
  status: Status;
  /**
   * The listener's intent: true from a play (or a track started to play) until a pause, the
   * end of the queue or an error. Buffering never changes it, so Play/Pause during a stall
   * pauses. `status` keeps following the audio element (Media Session, the icons).
   */
  wantsPlay: boolean;
  position: number;
  duration: number;
  /** The volume slider's position (0-1); the element's gain is positionToGain(volume). */
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  error: string | null;
  queueOpen: boolean;
  current: () => QueueTrack | null;
  playTracks: (tracks: Track[], start?: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: (auto?: boolean) => void;
  prev: () => void;
  jumpTo: (i: number) => void;
  seek: (sec: number) => void;
  seekBy: (delta: number) => void;
  setVolume: (v: number) => void;
  /** Move the volume slider by `delta` (the ↑/↓ keys, Volume Up/Down in the menu). */
  stepVolume: (delta: number) => void;
  /** Mute, or go back to the level from before the mute. */
  toggleMute: () => void;
  enqueueNext: (tracks: Track[]) => void;
  enqueueLast: (tracks: Track[]) => void;
  removeAt: (i: number) => void;
  move: (from: number, to: number) => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQueueOpen: (open: boolean) => void;
  /** `volume` is a slider position (persist.ts derives it from the saved gain). */
  hydrate: (s: { queue: QueueTrack[]; index: number; position: number; volume: number; shuffle: boolean; repeat: RepeatMode }) => void;
}

export const toQueueTrack = (t: Track): QueueTrack => ({ ...t, album_title: t.album_title ?? "", artist_name: t.artist_name ?? "", art_id: t.art_id ?? null });

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let retriedFor: number | null = null;
let pendingSeek: number | null = null;
let loadSeq = 0;
/** The slider position before the Mute button silenced it, for unmuting. */
let beforeMute: number | null = null;
/** A load() is resolving its stream URL: the element still holds the previous track. */
let loading = false;
/**
 * load() swapped the source of a playing element: the "pause" that can follow is the store's
 * own, not the listener's or the system's. Cleared by that pause or once the new track plays.
 */
let swapping = false;

// Listening history: one PlayCounter follows the current playback (rule in core's playRule.ts).
const plays = new PlayCounter();
/** A fresh playback of `track` starts now (new source, repeat-one, Previous, play after the end). */
function startPlayback(track: QueueTrack) {
  plays.start(track.id, Number.isFinite(audioEl.duration) ? audioEl.duration : track.duration);
}
/** Seconds listened in the current playback (read by the selftest). */
export const listenedSeconds = () => plays.listenedSeconds;
function recordPlay(p: CountedPlay) {
  void getCore()
    .then((c) => c.recordPlay(p.trackId, p.seconds))
    // Counts on track rows, the Library's played sorts and shelf, and Settings' total.
    .then(() => invalidateQueries(["albums", "album", "tracks", "playlist", "history"]))
    .catch(() => undefined); // history is best-effort; playback never depends on it
}

/** Resolve a fresh CDN URL for the track and point the audio element at it. */
/** Plays when it is ready if `wantsPlay` is still set then; skips on to the next track on failure only if so. */
function load(track: QueueTrack, force = false) {
  const seq = ++loadSeq;
  loading = true;
  retriedFor = force ? track.id : null;
  void (async () => {
    try {
      const core = await getCore();
      const { url } = await core.getFreshStreamUrl(track.id, force);
      if (seq !== loadSeq) return; // a newer load superseded this one
      loading = false;
      swapping = swappingAfter(swapping, { type: "load", paused: audioEl.paused });
      audioEl.src = url;
      audioEl.load();
      // A retry after a media error continues the same playback; anything else is a fresh one.
      if (!force || plays.trackId !== track.id) plays.start(track.id, track.duration);
      // A pause pressed while the URL was resolving wins; a play pressed then starts it here.
      if (usePlayer.getState().wantsPlay) {
        await audioEl.play().catch((e: unknown) => {
          if (seq === loadSeq) swapping = swappingAfter(swapping, { type: "playRejected" });
          // Autoplay refused: nothing will play until the listener asks, so stop intending to.
          if (seq === loadSeq && (e as { name?: unknown } | null)?.name === "NotAllowedError") usePlayer.setState({ wantsPlay: false, status: "paused" });
        });
      }
    } catch (e) {
      if (seq !== loadSeq) return;
      loading = false;
      const wanted = usePlayer.getState().wantsPlay;
      usePlayer.setState({ error: `Couldn't play "${track.title}". ${friendlyError(e)}`, status: "paused", wantsPlay: false });
      // During a Bandcamp cooldown every stale track would fail the same way: stop here
      // with the "try again after" message instead of skipping through the whole queue.
      if ((e as { code?: unknown } | null)?.code === "challenge_cooldown") return;
      const { queue, index } = usePlayer.getState();
      if (wanted && index < queue.length - 1) setTimeout(() => usePlayer.getState().next(true), 800);
    }
  })();
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  originalOrder: null,
  index: 0,
  status: "idle",
  wantsPlay: false,
  position: 0,
  duration: 0,
  volume: 1,
  shuffle: false,
  repeat: "off",
  error: null,
  queueOpen: false,

  current: () => get().queue[get().index] ?? null,

  playTracks: (tracks, start = 0) => {
    // Tracks that can't be streamed (a pre-order's unreleased ones) never enter the queue;
    // playback starts at the first streamable track from `start` on.
    const from = tracks.slice(start).find((t) => t.streamable) ?? tracks.find((t) => t.streamable);
    const playable = tracks.filter((t) => t.streamable).map(toQueueTrack);
    if (!playable.length || !from) return;
    let queue = playable;
    let index = Math.max(0, playable.findIndex((t) => t.id === from.id));
    if (get().shuffle) {
      const first = playable[index];
      queue = [first, ...shuffled(playable.filter((_, i) => i !== index))];
      index = 0;
      set({ originalOrder: playable });
    }
    set({ queue, index, status: "loading", wantsPlay: true, position: 0, duration: 0, error: null });
    load(queue[index]);
  },

  play: () => {
    const cur = get().current();
    if (!cur) return;
    set({ wantsPlay: true });
    // The track's URL is still resolving: load() starts it when it arrives.
    if (loading) set({ status: "loading" });
    else if (!audioEl.src) load(cur);
    else {
      // Play after the queue ended restarts the track from the top: a new playback.
      if (audioEl.ended) startPlayback(cur);
      void audioEl.play().catch(() => undefined);
    }
  },
  pause: () => {
    // While a track starts there may be no "pause" event to report it (the element can
    // already be paused), so the status follows the intent here.
    set(get().status === "loading" ? { wantsPlay: false, status: "paused" } : { wantsPlay: false });
    audioEl.pause();
  },
  toggle: () => (toggleAction(get().status, get().wantsPlay) === "pause" ? get().pause() : get().play()),

  next: (auto = false) => {
    const { queue, index, repeat } = get();
    if (!queue.length) return;
    if (auto && repeat === "one") {
      startPlayback(queue[index]);
      audioEl.currentTime = 0;
      void audioEl.play().catch(() => undefined);
      return;
    }
    let ni = index + 1;
    if (ni >= queue.length) {
      // End of queue: wrap when repeating (or when the user pressed Next), otherwise stop.
      if (auto && repeat !== "all") {
        audioEl.pause();
        set({ status: "paused", wantsPlay: false });
        return;
      }
      ni = 0;
    }
    set({ index: ni, status: "loading", wantsPlay: true, position: 0, duration: 0 });
    load(queue[ni]);
  },
  prev: () => {
    const { queue, index } = get();
    if (!queue.length) return;
    if (audioEl.currentTime > 3 || index === 0) {
      startPlayback(queue[index]);
      audioEl.currentTime = 0;
      return;
    }
    const ni = index - 1;
    set({ index: ni, status: "loading", wantsPlay: true, position: 0, duration: 0 });
    load(queue[ni]);
  },
  jumpTo: (i) => {
    const { queue } = get();
    if (i < 0 || i >= queue.length) return;
    set({ index: i, status: "loading", wantsPlay: true, position: 0, duration: 0 });
    load(queue[i]);
  },
  seek: (sec) => {
    plays.seeked();
    if (Number.isFinite(audioEl.duration)) audioEl.currentTime = Math.max(0, Math.min(sec, audioEl.duration));
    else pendingSeek = sec;
    set({ position: sec });
  },
  seekBy: (d) => get().seek(audioEl.currentTime + d),
  setVolume: (v) => {
    const vol = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    audioEl.volume = positionToGain(vol);
    set({ volume: vol });
  },
  stepVolume: (delta) => get().setVolume(stepVolume(get().volume, delta)),
  toggleMute: () => {
    const r = toggleMute(get().volume, beforeMute);
    get().setVolume(r.position);
    beforeMute = r.beforeMute;
  },

  enqueueNext: (tracks) => {
    tracks = tracks.filter((t) => t.streamable);
    if (!tracks.length) return;
    const { queue, index } = get();
    const add = tracks.map(toQueueTrack);
    const q = queue.length ? [...queue.slice(0, index + 1), ...add, ...queue.slice(index + 1)] : add;
    set({ queue: q });
    if (!queue.length) get().playTracks(tracks);
  },
  enqueueLast: (tracks) => {
    tracks = tracks.filter((t) => t.streamable);
    if (!tracks.length) return;
    const { queue } = get();
    if (!queue.length) return get().playTracks(tracks);
    set({ queue: [...queue, ...tracks.map(toQueueTrack)] });
  },
  removeAt: (i) => {
    const { queue, index } = get();
    if (i === index) return; // keep it simple: can't remove the playing track
    const q = queue.filter((_, k) => k !== i);
    set({ queue: q, index: i < index ? index - 1 : index });
  },
  move: (from, to) => {
    const { queue, index } = get();
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
    const q = queue.slice();
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let ni = index;
    if (from === index) ni = to;
    else if (from < index && to >= index) ni = index - 1;
    else if (from > index && to <= index) ni = index + 1;
    set({ queue: q, index: ni });
  },
  clearQueue: () => {
    const cur = get().current();
    set({ queue: cur ? [cur] : [], index: 0, originalOrder: null });
  },
  toggleShuffle: () => {
    const { shuffle, queue, index, originalOrder } = get();
    const cur = queue[index];
    if (!shuffle) {
      const rest = shuffled(queue.filter((_, i) => i !== index));
      set({ shuffle: true, originalOrder: queue, queue: cur ? [cur, ...rest] : rest, index: cur ? 0 : 0 });
    } else {
      const base = originalOrder ?? queue;
      const idx = cur ? Math.max(0, base.findIndex((t) => t.id === cur.id)) : 0;
      set({ shuffle: false, originalOrder: null, queue: base, index: idx });
    }
  },
  cycleRepeat: () => set({ repeat: get().repeat === "off" ? "all" : get().repeat === "all" ? "one" : "off" }),
  setQueueOpen: (open) => set({ queueOpen: open }),

  hydrate: (s) => {
    audioEl.volume = positionToGain(s.volume);
    // Ignore anything that isn't a full queue entry (e.g. state written by older versions or tools).
    const curId = s.queue[s.index]?.id;
    const queue = s.queue.filter((t) => t && typeof t.id === "number" && typeof t.title === "string" && typeof t.album_id === "number");
    const index = Math.max(0, queue.findIndex((t) => t.id === curId));
    set({ queue, index, volume: s.volume, shuffle: s.shuffle, repeat: s.repeat, position: queue.length ? s.position : 0, status: queue.length ? "paused" : "idle", wantsPlay: false });
    const cur = queue[index];
    if (cur) {
      pendingSeek = s.position;
      load(cur);
    }
  },
}));

// ---- audio element wiring ----
let lastTick = 0;
audioEl.addEventListener("timeupdate", () => {
  // Every report feeds listening history; only the store update below is throttled.
  const counted = plays.progress(audioEl.currentTime, performance.now(), audioEl.playbackRate);
  if (counted) recordPlay(counted);
  const now = performance.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  usePlayer.setState({ position: audioEl.currentTime });
});
audioEl.addEventListener("loadedmetadata", () => {
  usePlayer.setState({ duration: audioEl.duration });
  plays.setDuration(audioEl.duration);
  if (pendingSeek != null) {
    plays.seeked();
    audioEl.currentTime = pendingSeek;
    pendingSeek = null;
  }
});
audioEl.addEventListener("durationchange", () => {
  usePlayer.setState({ duration: audioEl.duration });
  plays.setDuration(audioEl.duration);
});
// Any jump of the playhead (seek bar, keys, media keys, restore) is not listening; a jump back
// to the start after the play counted is a manual restart (a fresh playback).
audioEl.addEventListener("seeking", () => plays.seeked(audioEl.currentTime));
// play/playing/pause/waiting: the rules are in core's audioEvents.ts (#55). The element's
// state is read when the event is handled, so a stale queued event can't undo a pause.
const onAudioEvent = (type: AudioEventType) => () => {
  const patch = audioEventPatch(type, { paused: audioEl.paused, ended: audioEl.ended, internal: loading || swapping });
  if (type === "pause") swapping = swappingAfter(swapping, { type: "pause" });
  if (type === "playing") swapping = swappingAfter(swapping, { type: "playing", paused: audioEl.paused });
  if (patch) usePlayer.setState(patch);
};
for (const type of ["play", "playing", "pause", "waiting"] as const) audioEl.addEventListener(type, onAudioEvent(type));
/** audio.paused, for the selftest's record of a toggle (only this module touches the element). */
export const elementPaused = () => audioEl.paused;
audioEl.addEventListener("ended", () => usePlayer.getState().next(true));
audioEl.addEventListener("error", () => {
  swapping = swappingAfter(swapping, { type: "error" });
  const cur = usePlayer.getState().current();
  if (!cur) return;
  if (retriedFor !== cur.id) {
    // Most likely an expired stream URL: ask the server to re-scrape and try once more. A
    // paused player (the listener, or the system) stays paused after the retry.
    if (usePlayer.getState().status === "paused") usePlayer.setState({ wantsPlay: false });
    load(cur, true);
    return;
  }
  usePlayer.setState({ error: `Couldn't play "${cur.title}"`, status: "paused", wantsPlay: false });
  const { queue, index } = usePlayer.getState();
  if (index < queue.length - 1) setTimeout(() => usePlayer.getState().next(true), 800);
});
