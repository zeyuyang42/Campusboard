import { create } from "zustand";
import type { QueueTrack, RepeatMode, Track } from "@bc/core";
import { audioEl } from "./audio";
import { getCore } from "../api/core";
import { friendlyError } from "../lib/errors";

export type Status = "idle" | "loading" | "playing" | "paused";

export interface PlayerState {
  queue: QueueTrack[];
  originalOrder: QueueTrack[] | null; // set while shuffle is on
  index: number;
  status: Status;
  position: number;
  duration: number;
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
  enqueueNext: (tracks: Track[]) => void;
  enqueueLast: (tracks: Track[]) => void;
  removeAt: (i: number) => void;
  move: (from: number, to: number) => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQueueOpen: (open: boolean) => void;
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

/** Resolve a fresh CDN URL for the track and point the audio element at it. */
function load(track: QueueTrack, autoplay: boolean, force = false) {
  const seq = ++loadSeq;
  retriedFor = force ? track.id : null;
  void (async () => {
    try {
      const core = await getCore();
      const { url } = await core.getFreshStreamUrl(track.id, force);
      if (seq !== loadSeq) return; // a newer load superseded this one
      audioEl.src = url;
      audioEl.load();
      if (autoplay) await audioEl.play().catch(() => undefined);
    } catch (e) {
      if (seq !== loadSeq) return;
      usePlayer.setState({ error: `Couldn't play "${track.title}". ${friendlyError(e)}`, status: "paused" });
      // During a Bandcamp cooldown every stale track would fail the same way: stop here
      // with the "try again after" message instead of skipping through the whole queue.
      if ((e as { code?: unknown } | null)?.code === "challenge_cooldown") return;
      const { queue, index } = usePlayer.getState();
      if (autoplay && index < queue.length - 1) setTimeout(() => usePlayer.getState().next(true), 800);
    }
  })();
}

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  originalOrder: null,
  index: 0,
  status: "idle",
  position: 0,
  duration: 0,
  volume: 1,
  shuffle: false,
  repeat: "off",
  error: null,
  queueOpen: false,

  current: () => get().queue[get().index] ?? null,

  playTracks: (tracks, start = 0) => {
    const playable = tracks.map(toQueueTrack);
    if (!playable.length) return;
    let queue = playable;
    let index = Math.min(start, playable.length - 1);
    if (get().shuffle) {
      const first = playable[index];
      queue = [first, ...shuffled(playable.filter((_, i) => i !== index))];
      index = 0;
      set({ originalOrder: playable });
    }
    set({ queue, index, status: "loading", position: 0, duration: 0, error: null });
    load(queue[index], true);
  },

  play: () => {
    const cur = get().current();
    if (!cur) return;
    if (!audioEl.src) load(cur, true);
    else void audioEl.play().catch(() => undefined);
  },
  pause: () => audioEl.pause(),
  toggle: () => (get().status === "playing" ? get().pause() : get().play()),

  next: (auto = false) => {
    const { queue, index, repeat } = get();
    if (!queue.length) return;
    if (auto && repeat === "one") {
      audioEl.currentTime = 0;
      void audioEl.play().catch(() => undefined);
      return;
    }
    let ni = index + 1;
    if (ni >= queue.length) {
      // End of queue: wrap when repeating (or when the user pressed Next), otherwise stop.
      if (auto && repeat !== "all") {
        audioEl.pause();
        set({ status: "paused" });
        return;
      }
      ni = 0;
    }
    set({ index: ni, status: "loading", position: 0, duration: 0 });
    load(queue[ni], true);
  },
  prev: () => {
    const { queue, index } = get();
    if (!queue.length) return;
    if (audioEl.currentTime > 3 || index === 0) {
      audioEl.currentTime = 0;
      return;
    }
    const ni = index - 1;
    set({ index: ni, status: "loading", position: 0, duration: 0 });
    load(queue[ni], true);
  },
  jumpTo: (i) => {
    const { queue } = get();
    if (i < 0 || i >= queue.length) return;
    set({ index: i, status: "loading", position: 0, duration: 0 });
    load(queue[i], true);
  },
  seek: (sec) => {
    if (Number.isFinite(audioEl.duration)) audioEl.currentTime = Math.max(0, Math.min(sec, audioEl.duration));
    else pendingSeek = sec;
    set({ position: sec });
  },
  seekBy: (d) => get().seek(audioEl.currentTime + d),
  setVolume: (v) => {
    const vol = Math.max(0, Math.min(1, v));
    audioEl.volume = vol;
    set({ volume: vol });
  },

  enqueueNext: (tracks) => {
    const { queue, index } = get();
    const add = tracks.map(toQueueTrack);
    const q = queue.length ? [...queue.slice(0, index + 1), ...add, ...queue.slice(index + 1)] : add;
    set({ queue: q });
    if (!queue.length) get().playTracks(tracks);
  },
  enqueueLast: (tracks) => {
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
    audioEl.volume = s.volume;
    // Ignore anything that isn't a full queue entry (e.g. state written by older versions or tools).
    const curId = s.queue[s.index]?.id;
    const queue = s.queue.filter((t) => t && typeof t.id === "number" && typeof t.title === "string" && typeof t.album_id === "number");
    const index = Math.max(0, queue.findIndex((t) => t.id === curId));
    set({ queue, index, volume: s.volume, shuffle: s.shuffle, repeat: s.repeat, position: queue.length ? s.position : 0, status: queue.length ? "paused" : "idle" });
    const cur = queue[index];
    if (cur) {
      pendingSeek = s.position;
      load(cur, false);
    }
  },
}));

// ---- audio element wiring ----
let lastTick = 0;
audioEl.addEventListener("timeupdate", () => {
  const now = performance.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  usePlayer.setState({ position: audioEl.currentTime });
});
audioEl.addEventListener("loadedmetadata", () => {
  usePlayer.setState({ duration: audioEl.duration });
  if (pendingSeek != null) {
    audioEl.currentTime = pendingSeek;
    pendingSeek = null;
  }
});
audioEl.addEventListener("durationchange", () => usePlayer.setState({ duration: audioEl.duration }));
audioEl.addEventListener("play", () => usePlayer.setState({ status: "playing", error: null }));
audioEl.addEventListener("playing", () => usePlayer.setState({ status: "playing", error: null }));
audioEl.addEventListener("pause", () => {
  if (!audioEl.ended) usePlayer.setState({ status: "paused" });
});
audioEl.addEventListener("waiting", () => usePlayer.setState({ status: "loading" }));
audioEl.addEventListener("ended", () => usePlayer.getState().next(true));
audioEl.addEventListener("error", () => {
  const cur = usePlayer.getState().current();
  if (!cur) return;
  if (retriedFor !== cur.id) {
    // Most likely an expired stream URL: ask the server to re-scrape and try once more.
    load(cur, usePlayer.getState().status !== "paused", true);
    return;
  }
  usePlayer.setState({ error: `Couldn't play "${cur.title}"`, status: "paused" });
  const { queue, index } = usePlayer.getState();
  if (index < queue.length - 1) setTimeout(() => usePlayer.getState().next(true), 800);
});
