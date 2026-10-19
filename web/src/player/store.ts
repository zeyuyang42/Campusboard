import { create } from "zustand";
import {
  audioEventPatch, PlayCounter, swappingAfter, positionToGain, stepVolume, toggleAction, toggleMute,
  crossfadeGains, elementRole, fadeProgress, fadeSeconds, gaplessDelayMs, parsePlaybackSettings, preloadDue, preloadStale, routeElementEvent,
  standbyUsable, transitionAfter, isQueueRadio, transitionKind, transitionPoint, upcomingIndex,
  CROSSFADE_MIN_SEC, DEFAULT_PLAYBACK, GAPLESS_ARM_SEC, GAPLESS_START_LEAD_MS, PLAYBACK_SETTING_KEY, STANDBY_PRIME_MS, TRANSITION_IDLE,
  type AudioEventType, type CountedPlay, type ElementEventType, type PlaybackSettings, type QueueTrack, type RepeatMode, type Track,
  type TransitionEvent, type TransitionKind, type TransitionState,
} from "@bc/core";
import { audioEls } from "./audio";
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
  /** Settings > Playback (#35): start the next track exactly when the current one ends. */
  gapless: boolean;
  /** Settings > Playback: crossfade between tracks of different albums, in seconds (0 = off). */
  crossfadeSec: number;
  current: () => QueueTrack | null;
  /** Returns how many tracks were queued (capped at MAX_QUEUE). */
  playTracks: (tracks: Track[], start?: number) => number;
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
  /** Both return how many tracks were added (the queue stops at MAX_QUEUE). */
  enqueueNext: (tracks: Track[]) => number;
  enqueueLast: (tracks: Track[]) => number;
  removeAt: (i: number) => void;
  move: (from: number, to: number) => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQueueOpen: (open: boolean) => void;
  /** Change and save the Gapless / Crossfade settings. */
  setPlayback: (patch: Partial<PlaybackSettings>) => void;
  /** `volume` is a slider position (persist.ts derives it from the saved gain). */
  hydrate: (s: { queue: QueueTrack[]; index: number; position: number; volume: number; shuffle: boolean; repeat: RepeatMode }) => void;
}

/**
 * The queue holds at most this many tracks. It is persisted as one JSON value, so a bulk
 * action on a large library must not grow it without bound.
 */
export const MAX_QUEUE = 10_000;

/** A queue entry. Lyrics are left out (the queue is persisted often); Now playing loads them. */
export const toQueueTrack = (t: Track): QueueTrack => ({ ...t, lyrics: null, album_title: t.album_title ?? "", artist_name: t.artist_name ?? "", art_id: t.art_id ?? null });

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- the two elements (#35) ----
// The active element plays the current track: the queue index, status, wantsPlay, the play
// counter, the position and Now Playing all follow it. The other one is the standby (the next
// track preloading at volume 0), the fading one (the previous track playing out its end or
// fading out after a transition), or idle. Events are routed by role (core's routeElementEvent).
let activeIdx = 0;
const active = () => audioEls[activeIdx];
const other = () => audioEls[1 - activeIdx];

let retriedFor: number | null = null;
/**
 * A position to apply once the track's metadata arrives (a seek before it had a source, a
 * restore, a retry). Tied to the track it was set for: a load of another track drops it (#75).
 */
let pendingSeek: { trackId: number; sec: number } | null = null;
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
/** Tracks that failed in a row since something last played; a queue that all fails stops. */
let failStreak = 0;
/** The load() in progress was started by skipAfterError, so it continues the failure streak. */
let skippingError = false;
/** The visible-window skip waiting to run; anything the listener does first cancels it. */
let skipTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPendingSkip() {
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
}

// Listening history: one PlayCounter follows the current playback (rule in core's playRule.ts).
const plays = new PlayCounter();
/** A fresh playback of `track` starts now (new source, repeat-one, Previous, play after the end). */
function startPlayback(track: QueueTrack) {
  const el = active();
  plays.start(track.id, Number.isFinite(el.duration) ? el.duration : track.duration);
}
/** Seconds listened in the current playback (read by the selftest). */
export const listenedSeconds = () => plays.listenedSeconds;
function recordPlay(p: CountedPlay) {
  // A radio episode (negative id) is not a library track: history stays about the library.
  if (p.trackId <= 0) return;
  void getCore()
    .then((c) => c.recordPlay(p.trackId, p.seconds))
    // Counts on track rows, the Library's played sorts and shelf, and Settings' total.
    .then(() => invalidateQueries(["albums", "album", "tracks", "playlist", "history"]))
    .catch(() => undefined); // history is best-effort; playback never depends on it
}

/** A fresh stream URL for a queue entry: a library track's, or a radio episode's (#44). */
async function streamUrlFor(track: QueueTrack, force = false): Promise<{ url: string; expires_at: number }> {
  const core = await getCore();
  return track.radio ? core.radioStreamUrl(track.radio.show_id, force) : core.getFreshStreamUrl(track.id, force);
}

/** Resolve a fresh CDN URL for the track and point the active audio element at it. */
/** Plays when it is ready if `wantsPlay` is still set then; skips on to the next track on failure only if so. */
function load(track: QueueTrack, force = false) {
  // A new source for the active element: a preload or a fade in progress is moot.
  cancelTransition();
  const seq = ++loadSeq;
  loading = true;
  retriedFor = force ? track.id : null;
  if (pendingSeek && pendingSeek.trackId !== track.id) pendingSeek = null;
  // A load the listener asked for starts counting failures afresh and wins over a pending skip.
  if (!force && !skippingError) { failStreak = 0; cancelPendingSkip(); }
  void (async () => {
    try {
      const { url } = await streamUrlFor(track, force);
      if (seq !== loadSeq) return; // a newer load superseded this one
      loading = false;
      const el = active();
      swapping = swappingAfter(swapping, { type: "load", paused: el.paused });
      el.src = url;
      el.load();
      // A retry after a media error continues the same playback; anything else is a fresh one.
      if (!force || plays.trackId !== track.id) plays.start(track.id, track.duration);
      // A pause pressed while the URL was resolving wins; a play pressed then starts it here.
      if (usePlayer.getState().wantsPlay) {
        await el.play().catch((e: unknown) => {
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
      // The element still holds the previous track: silence it and drop that source, so it
      // can't play on (or end and advance) under this track's name. Play then reloads this one.
      const el = active();
      el.pause();
      if (el.hasAttribute("src")) { el.removeAttribute("src"); el.load(); }
      // During a Bandcamp cooldown every stale track would fail the same way: stop here
      // with the "try again after" message instead of skipping through the whole queue.
      if ((e as { code?: unknown } | null)?.code === "challenge_cooldown") return;
      if (wanted) skipAfterError(true);
    }
  })();
}

/**
 * After a track fails, move on to the next one. With the window visible the error shows for a
 * moment first. With it hidden (closed) nothing is audible after the failure, and WebKit may
 * then hold a hidden page's timers indefinitely (#67), so it moves on right away.
 * `play` is false for a track that failed while paused: the next one is loaded but not started.
 * A load, Play or Pause from the listener in the meantime cancels the skip.
 */
function skipAfterError(play: boolean) {
  failStreak++;
  if (shouldStopAfterError()) return;
  const seq = loadSeq;
  const advance = () => {
    skipTimer = null;
    if (seq !== loadSeq) return; // something else was loaded since
    if (shouldStopAfterError()) return; // the queue may have been edited in the meantime
    skippingError = true;
    try {
      // A plain Next, not the end-of-track one: repeat-one would replay the failed track (#69).
      if (play) usePlayer.getState().next();
      else {
        const s = usePlayer.getState();
        const ni = (s.index + 1) % s.queue.length;
        usePlayer.setState({ index: ni, status: "paused", wantsPlay: false, position: 0, duration: 0 });
        load(s.queue[ni]);
      }
    } finally { skippingError = false; }
  };
  cancelPendingSkip();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") advance();
  else skipTimer = setTimeout(advance, 800);
}

/**
 * Stop rather than skip: at the end of the queue unless repeating all, once every track has
 * failed in a row, or when the failed track is the only one left.
 */
function shouldStopAfterError() {
  const { queue, index, repeat } = usePlayer.getState();
  return queue.length <= 1 || failStreak >= queue.length || (index >= queue.length - 1 && repeat !== "all");
}

// ---- gapless and crossfade (#35; the rules are in core's transition.ts) ----
let tx: TransitionState = TRANSITION_IDLE;
/** Bumped by every cancel, so a preload's URL that arrives late is dropped. */
let txSeq = 0;
/** The URL the standby element was given, so a stale canplay can't mark another one ready. */
let preloadUrl: string | null = null;
let armTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let tailTimer: ReturnType<typeof setTimeout> | null = null;
/** How often the fade's volumes are updated while the window is visible (timeupdate covers a hidden one). */
const FADE_TICK_MS = 50;
/**
 * Start the next element this long before the end for a gapless switch; null starts it only
 * on "ended". Diagnostics (dev builds) can change it to compare the two.
 */
let startLeadMs: number | null = GAPLESS_START_LEAD_MS;

interface TransitionRecord { at: number; from: number | null; to: number; kind: TransitionKind | "ended"; fadeSec: number; prevRemaining: number }
/** The last few transitions, for the selftest and the browser-mode measurements. */
const transitions: TransitionRecord[] = [];

const finitePositive = (x: number) => Number.isFinite(x) && x > 0;
const dispatch = (e: TransitionEvent) => { tx = transitionAfter(tx, e); };
const settingsOf = (s: PlayerState): PlaybackSettings => ({ gapless: s.gapless, crossfadeSec: s.crossfadeSec });

function clearTimers() {
  if (armTimer) clearTimeout(armTimer);
  if (fadeTimer) clearInterval(fadeTimer);
  if (tailTimer) clearTimeout(tailTimer);
  armTimer = fadeTimer = tailTimer = null;
}

/** Stop an element and drop its source, so it holds no stream and is never Now Playing. */
function release(el: HTMLAudioElement) {
  el.pause();
  el.muted = baseMuted[audioEls.indexOf(el)];
  if (el.hasAttribute("src")) {
    el.removeAttribute("src");
    el.load();
  }
  el.volume = 0;
}

/** Drop any preload or fade: release the other element and give the active one its full gain. */
function cancelTransition() {
  txSeq++;
  clearTimers();
  dispatch({ type: "invalidate" });
  preloadUrl = null;
  release(other());
  active().volume = positionToGain(usePlayer.getState().volume);
}

/** The fade (or the gapless tail) is over: the previous element goes, the new one plays at full gain. */
function finishFade() {
  if (tx.phase !== "fading") return;
  clearTimers();
  dispatch({ type: "fadeDone" });
  const prev = other();
  prev.pause();
  active().volume = positionToGain(usePlayer.getState().volume);
  // Released a moment later: tearing a player down in the same instant the next one starts
  // delayed that start by ~100 ms in WebKit. Paused, it is not Now Playing meanwhile. Skipped
  // if it was given a new source (the next preload) or took over again by then.
  const src = prev.src;
  setTimeout(() => { if (prev !== active() && prev.src === src && tx.phase !== "preloading" && tx.phase !== "ready") release(prev); }, RELEASE_DELAY_MS);
}
const RELEASE_DELAY_MS = 1000;

function fadeTick() {
  if (tx.phase !== "fading") return;
  const prev = other();
  if (prev.ended) return finishFade();
  if (tx.fadeSec <= 0) return; // a gapless tail plays its last milliseconds at full gain
  const p = fadeProgress(prev.currentTime, tx.fadeStart, tx.fadeSec);
  const g = crossfadeGains(p, usePlayer.getState().volume);
  prev.volume = g.out;
  active().volume = g.in;
  if (p >= 1) finishFade();
}

function upcoming(): { index: number; track: QueueTrack } | null {
  const { queue, index, repeat } = usePlayer.getState();
  const ni = upcomingIndex(queue.length, index, repeat);
  return ni == null || !queue[ni] ? null : { index: ni, track: queue[ni] };
}

/** What the coming transition is, or null when there is none to prepare. */
function plan() {
  const s = usePlayer.getState();
  const cur = s.current();
  const up = upcoming();
  const duration = active().duration;
  if (!cur || !up || !finitePositive(duration)) return null;
  const settings = settingsOf(s);
  const kind = transitionKind(cur, up.track, settings, duration);
  const fadeSec = kind === "crossfade" ? fadeSeconds(settings, duration, up.track.duration) : 0;
  return { up, kind, fadeSec, point: transitionPoint(kind, duration, fadeSec) };
}

/** Resolve the next track's fresh URL and load it into the standby element at volume 0. */
function preload(track: QueueTrack) {
  dispatch({ type: "preload", trackId: track.id });
  const seq = ++txSeq;
  void (async () => {
    try {
      const { url, expires_at } = await streamUrlFor(track);
      if (seq !== txSeq || tx.phase !== "preloading") return;
      dispatch({ type: "resolved", expiresAt: expires_at });
      const el = other();
      // Volume 0 while it waits: it is paused (and only muted while priming), so it is silent
      // and starts a crossfade from silence. Volume 0 alone would not keep a PLAYING element
      // out of Now Playing (WebKit still counts it eligible), which is why prime() mutes.
      el.volume = 0;
      el.src = url;
      preloadUrl = el.src; // as the element normalised it, for the canplay check
      primedUrl = null; // the same URL may come round again (repeat, replaying an album)
      el.load();
    } catch {
      if (seq === txSeq) dispatch({ type: "failed" }); // it loads the plain way at the end
    }
  })();
}

/** The source the standby element primed (or is priming), so canplay and canplaythrough prime it once. */
let primedUrl: string | null = null;
/** Each element's `muted` as audio.ts set it (true in a muted selftest); priming puts it back. */
const baseMuted = audioEls.map((el) => el.muted);

/**
 * Play the loaded standby muted for a moment, then pause it back at 0, before calling it ready.
 * WebKit (AVFoundation) prerolls a playing element: a primed element starts in ~35-60 ms
 * against ~130-300 ms for one that only loaded (measured in Playwright's WebKit, see #35).
 * Muted, not volume 0, so it is never Now Playing eligible meanwhile and never takes over
 * Control Center or the media keys from the active element.
 */
function prime(el: HTMLAudioElement) {
  const seq = txSeq;
  primedUrl = el.src;
  el.muted = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    el.removeEventListener("timeupdate", onProgress);
    if (timer) clearTimeout(timer);
    if (seq !== txSeq || tx.phase !== "preloading") return; // cancelled: release() reset the element
    el.pause();
    el.currentTime = 0;
    // Stays muted until start(): priming made it the most recently started element, and an
    // unmuted one (even at volume 0) would be Now Playing eligible, so WebKit could pick the
    // paused standby and F8 would send "play" instead of "pause" for the rest of the track.
    dispatch({ type: "canPlay" });
  };
  // Done once its clock has run for a moment. A hidden window may not advance muted media,
  // so a timer ends the prime either way.
  const onProgress = () => { if (el.currentTime >= STANDBY_PRIME_MS / 1000) finish(); };
  el.addEventListener("timeupdate", onProgress);
  timer = setTimeout(finish, STANDBY_PRIME_MS + 4000);
  void el.play().catch(() => undefined);
}

/**
 * Called on the active element's progress and by the arm timer: preload when due, and start
 * the next track at its point. Returns true if it started it. `fromEnded`: the active element
 * has just ended, so start now if the standby can (a missed fade becomes a plain switch).
 */
function stepTransition(fromEnded = false): boolean {
  if (tx.phase === "fading") { fadeTick(); return false; }
  const s = usePlayer.getState();
  const el = active();
  if (preloadStale(tx, upcoming()?.track.id ?? null)) cancelTransition();
  const p = plan();
  if (!p || p.kind === "plain" || loading || !s.wantsPlay || (!fromEnded && el.paused)) {
    if (p?.kind === "plain" && tx.phase !== "idle") cancelTransition();
    return false;
  }
  if (tx.phase === "idle" && preloadDue(el.currentTime, p.point)) preload(p.up.track);
  if (tx.phase === "ready" && !standbyUsable(tx, p.up.track.id, Date.now())) {
    cancelTransition(); // the preloaded URL is about to expire: the plain path fetches a fresh one
    return false;
  }
  if (tx.phase !== "ready") return false;
  if (fromEnded) { start(p.up, 0, "ended"); return true; }
  if (p.kind === "gapless" && startLeadMs == null) return false; // waits for "ended"
  const lead = p.kind === "gapless" ? (startLeadMs ?? 0) : 0;
  const remaining = p.point - el.currentTime;
  if (remaining > GAPLESS_ARM_SEC) return false;
  const wait = gaplessDelayMs(remaining, el.playbackRate || 1, lead);
  if (wait <= 1) { start(p.up, p.fadeSec, p.kind); return true; }
  // Close to the point: poll the playhead (it is interpolated, unlike timeupdate's 250 ms steps).
  if (armTimer) clearTimeout(armTimer);
  armTimer = setTimeout(() => { armTimer = null; stepTransition(); }, wait > 40 ? wait - 25 : Math.max(1, wait - 1));
  return false;
}

/** The standby element takes over as the active one. */
function start(up: { index: number; track: QueueTrack }, fadeSec: number, kind: TransitionKind | "ended") {
  clearTimers();
  const prev = active();
  const next = other();
  const s = usePlayer.getState();
  // Started late (a seek into the fade): fade over what is left, so it still ends at the end.
  // Too little left to fade: a plain switch, and the old track stops now rather than playing
  // its last moments at full volume over the new one (it belongs to another album).
  if (fadeSec > 0) {
    const left = prev.duration - prev.currentTime;
    if (Number.isFinite(left)) fadeSec = left >= CROSSFADE_MIN_SEC ? Math.min(fadeSec, left) : 0;
    if (fadeSec === 0) prev.pause();
  }
  transitions.push({ at: performance.now(), from: s.current()?.id ?? null, to: up.track.id, kind, fadeSec, prevRemaining: prev.duration - prev.currentTime });
  if (transitions.length > 10) transitions.shift();
  dispatch({ type: "start", fadeStart: prev.currentTime, fadeSec });
  activeIdx = 1 - activeIdx;
  preloadUrl = null;
  swapping = false;
  retriedFor = null;
  pendingSeek = null;
  next.volume = fadeSec > 0 ? 0 : positionToGain(s.volume);
  next.muted = baseMuted[audioEls.indexOf(next)]; // muted since priming; audible from here
  // From here the play counter, the queue index, the position and Now Playing follow `next`.
  plays.start(up.track.id, finitePositive(next.duration) ? next.duration : up.track.duration);
  lastTick = 0;
  usePlayer.setState({ index: up.index, position: 0, duration: finitePositive(next.duration) ? next.duration : (up.track.duration ?? 0), error: null });
  void next.play().catch((e: unknown) => {
    if (active() !== next) return;
    if ((e as { name?: unknown } | null)?.name === "NotAllowedError") usePlayer.setState({ wantsPlay: false, status: "paused" });
  });
  if (prev.ended || prev.paused) finishFade();
  else if (fadeSec > 0) fadeTimer = setInterval(fadeTick, FADE_TICK_MS);
  // A gapless tail ends on its own within the lead; this only guards against one that stalls.
  else tailTimer = setTimeout(finishFade, Math.max(0, startLeadMs ?? 0) + 1500);
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
  gapless: DEFAULT_PLAYBACK.gapless,
  crossfadeSec: DEFAULT_PLAYBACK.crossfadeSec,

  current: () => get().queue[get().index] ?? null,

  playTracks: (tracks, start = 0) => {
    // Tracks that can't be streamed (a pre-order's unreleased ones) never enter the queue;
    // playback starts at the first streamable track from `start` on.
    const from = tracks.slice(start).find((t) => t.streamable) ?? tracks.find((t) => t.streamable);
    const all = tracks.filter((t) => t.streamable);
    if (!all.length || !from) return 0;
    // Over the cap, keep a window that starts at (or contains) the chosen track.
    const at = Math.max(0, all.indexOf(from));
    const lo = all.length <= MAX_QUEUE ? 0 : Math.min(at, all.length - MAX_QUEUE);
    const playable = all.slice(lo, lo + MAX_QUEUE).map(toQueueTrack);
    let queue = playable;
    let index = at - lo;
    if (get().shuffle) {
      const first = playable[index];
      queue = [first, ...shuffled(playable.filter((_, i) => i !== index))];
      index = 0;
      set({ originalOrder: playable });
    }
    set({ queue, index, status: "loading", wantsPlay: true, position: 0, duration: 0, error: null });
    load(queue[index]);
    return queue.length;
  },

  play: () => {
    const cur = get().current();
    if (!cur) return;
    cancelPendingSkip(); // Play after an error retries this track instead
    set({ wantsPlay: true });
    const el = active();
    // The track's URL is still resolving: load() starts it when it arrives.
    if (loading) set({ status: "loading" });
    else if (!el.src) load(cur);
    else {
      // Play after the queue ended restarts the track from the top: a new playback.
      if (el.ended) startPlayback(cur);
      void el.play().catch(() => undefined);
      // Paused mid-crossfade: both carry on from where they were, and so do the volume ticks.
      if (tx.phase === "fading" && !other().ended) {
        void other().play().catch(() => undefined);
        if (tx.fadeSec > 0 && !fadeTimer) fadeTimer = setInterval(fadeTick, FADE_TICK_MS);
      }
    }
  },
  pause: () => {
    // While a track starts there may be no "pause" event to report it (the element can
    // already be paused), so the status follows the intent here.
    set(get().status === "loading" ? { wantsPlay: false, status: "paused" } : { wantsPlay: false });
    cancelPendingSkip();
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    active().pause();
    if (tx.phase === "fading") {
      other().pause(); // a crossfade pauses as a whole
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; } // nothing moves until play()
    }
  },
  toggle: () => (toggleAction(get().status, get().wantsPlay) === "pause" ? get().pause() : get().play()),

  next: (auto = false) => {
    const { queue, index, repeat } = get();
    if (!queue.length) return;
    const el = active();
    if (auto && repeat === "one") {
      startPlayback(queue[index]);
      el.currentTime = 0;
      void el.play().catch(() => undefined);
      return;
    }
    let ni = index + 1;
    if (ni >= queue.length) {
      // End of queue: wrap when repeating (or when the user pressed Next), otherwise stop.
      if (auto && repeat !== "all") {
        el.pause();
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
    const el = active();
    if (el.currentTime > 3 || index === 0) {
      if (tx.phase === "fading") cancelTransition();
      startPlayback(queue[index]);
      el.currentTime = 0;
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
    // Seeking cancels a crossfade: the new track carries on alone at full volume. A preload
    // stays (still the next track); the start timer is re-armed from the new position.
    if (tx.phase === "fading") cancelTransition();
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    plays.seeked();
    const el = active();
    if (Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(sec, el.duration));
    else { const cur = get().current(); pendingSeek = cur ? { trackId: cur.id, sec } : null; }
    set({ position: sec });
  },
  seekBy: (d) => get().seek(active().currentTime + d),
  setVolume: (v) => {
    const vol = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    set({ volume: vol });
    // Mid-crossfade both gains follow the new level at once; otherwise only the active one plays.
    if (tx.phase === "fading" && tx.fadeSec > 0) fadeTick();
    else active().volume = positionToGain(vol);
  },
  stepVolume: (delta) => get().setVolume(stepVolume(get().volume, delta)),
  toggleMute: () => {
    const r = toggleMute(get().volume, beforeMute);
    get().setVolume(r.position);
    beforeMute = r.beforeMute;
  },

  enqueueNext: (tracks) => {
    failStreak = 0; // the queue changed: count failures in it afresh
    const { queue, index } = get();
    if (!queue.length) return get().playTracks(tracks);
    tracks = tracks.filter((t) => t.streamable).slice(0, Math.max(0, MAX_QUEUE - queue.length));
    if (!tracks.length) return 0;
    const add = tracks.map(toQueueTrack);
    set({ queue: [...queue.slice(0, index + 1), ...add, ...queue.slice(index + 1)] });
    return add.length;
  },
  enqueueLast: (tracks) => {
    failStreak = 0; // the queue changed: count failures in it afresh
    const { queue } = get();
    if (!queue.length) return get().playTracks(tracks);
    tracks = tracks.filter((t) => t.streamable).slice(0, Math.max(0, MAX_QUEUE - queue.length));
    if (!tracks.length) return 0;
    set({ queue: [...queue, ...tracks.map(toQueueTrack)] });
    return tracks.length;
  },
  removeAt: (i) => {
    failStreak = 0; // the queue changed: count failures in it afresh
    const { queue, index } = get();
    if (i === index) return; // keep it simple: can't remove the playing track
    const q = queue.filter((_, k) => k !== i);
    set({ queue: q, index: i < index ? index - 1 : index });
  },
  move: (from, to) => {
    failStreak = 0; // the queue changed: count failures in it afresh
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
    failStreak = 0; // the queue changed: count failures in it afresh
    const cur = get().current();
    set({ queue: cur ? [cur] : [], index: 0, originalOrder: null });
  },
  toggleShuffle: () => {
    failStreak = 0; // the queue changed: count failures in it afresh
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
  // A queue, repeat or settings change that alters the next track is picked up on the next
  // progress report: the stale preload is dropped (preloadStale) and the new one made.
  setPlayback: (patch) => {
    const next = parsePlaybackSettings({ ...settingsOf(get()), ...patch });
    set(next);
    playbackWrites = playbackWrites.then(async () => (await getCore()).setSetting(PLAYBACK_SETTING_KEY, next)).catch(() => undefined);
  },

  hydrate: (s) => {
    active().volume = positionToGain(s.volume);
    // Ignore anything that isn't a full queue entry (e.g. state written by older versions or tools).
    const curId = s.queue[s.index]?.id;
    // Older versions persisted lyrics and had no cap.
    // A radio episode's `radio` field must have the shape radioQueueTrack gives it (#44).
    const queue = s.queue.filter((t) => t && typeof t.id === "number" && typeof t.title === "string" && typeof t.album_id === "number" && (t.radio === undefined || isQueueRadio(t.radio))).slice(0, MAX_QUEUE).map(toQueueTrack);
    const index = Math.max(0, queue.findIndex((t) => t.id === curId));
    set({ queue, index, volume: s.volume, shuffle: s.shuffle, repeat: s.repeat, position: queue.length ? s.position : 0, status: queue.length ? "paused" : "idle", wantsPlay: false });
    const cur = queue[index];
    if (cur) {
      pendingSeek = { trackId: cur.id, sec: s.position };
      // An episode's URL costs a Bandcamp request: it is resolved on the first Play (play()
      // loads a track without a source), not at launch.
      if (cur.radio) usePlayer.setState({ duration: cur.duration ?? 0 });
      else load(cur);
    }
  },
}));

// settings.key='playback' writes run one after another, so quick changes can't land out of order.
let playbackWrites: Promise<unknown> = Promise.resolve();
/** Read the saved Gapless / Crossfade settings (called once at startup). */
export async function loadPlaybackSettings() {
  const saved = await getCore().then((c) => c.getSetting(PLAYBACK_SETTING_KEY)).catch(() => null);
  usePlayer.setState(parsePlaybackSettings(saved));
}

// ---- audio element wiring ----
// Both elements get the same listeners; routeElementEvent decides what an event feeds by the
// element's role when it is handled, so a preload or a fade-out never changes the store.
let lastTick = 0;
const onAudioEvent = (type: AudioEventType) => {
  const el = active();
  const patch = audioEventPatch(type, { paused: el.paused, ended: el.ended, internal: loading || swapping });
  if (type === "pause") swapping = swappingAfter(swapping, { type: "pause" });
  if (type === "playing") swapping = swappingAfter(swapping, { type: "playing", paused: el.paused });
  if (type === "playing") failStreak = 0;
  // A pause from outside (the system) mid-crossfade stops the fading track too.
  if (type === "pause" && el.paused && tx.phase === "fading") {
    other().pause();
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  }
  if (patch) usePlayer.setState(patch);
};

const storeHandlers: Partial<Record<ElementEventType, (el: HTMLAudioElement) => void>> = {
  timeupdate: (el) => {
    // Every report feeds listening history; only the store update below is throttled.
    const counted = plays.progress(el.currentTime, performance.now(), el.playbackRate);
    if (counted) recordPlay(counted);
    stepTransition();
    if (el !== active()) return; // it just handed over: the new track's position is 0
    const now = performance.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    usePlayer.setState({ position: el.currentTime });
  },
  loadedmetadata: (el) => {
    usePlayer.setState({ duration: el.duration });
    plays.setDuration(el.duration);
    if (pendingSeek != null && pendingSeek.trackId === usePlayer.getState().current()?.id) {
      plays.seeked();
      el.currentTime = pendingSeek.sec;
      pendingSeek = null;
    }
  },
  durationchange: (el) => {
    usePlayer.setState({ duration: el.duration });
    plays.setDuration(el.duration);
  },
  // Any jump of the playhead (seek bar, keys, media keys, restore) is not listening; a jump back
  // to the start after the play counted is a manual restart (a fresh playback).
  seeking: (el) => plays.seeked(el.currentTime),
  // play/playing/pause/waiting: the rules are in core's audioEvents.ts (#55). The element's
  // state is read when the event is handled, so a stale queued event can't undo a pause.
  play: () => onAudioEvent("play"),
  playing: () => onAudioEvent("playing"),
  pause: () => onAudioEvent("pause"),
  waiting: () => onAudioEvent("waiting"),
  // Gapless: the standby starts here if the early start didn't happen; otherwise the plain way.
  ended: () => { if (!stepTransition(true)) usePlayer.getState().next(true); },
  error: (el) => {
    swapping = swappingAfter(swapping, { type: "error" });
    const cur = usePlayer.getState().current();
    if (!cur) return;
    if (retriedFor !== cur.id) {
      // Most likely an expired stream URL: ask the server to re-scrape and try once more. A
      // paused player (the listener, or the system) stays paused after the retry.
      if (usePlayer.getState().status === "paused") usePlayer.setState({ wantsPlay: false });
      // Resume where it failed: a network blip mustn't restart an episode from the top.
      const at = Math.max(Number.isFinite(el.currentTime) ? el.currentTime : 0, usePlayer.getState().position || 0);
      if (!pendingSeek && at > 0) pendingSeek = { trackId: cur.id, sec: at };
      load(cur, true);
      return;
    }
    // Paused (the retry kept it so): move on to the next track but leave it paused. Staying
    // would leave Play on a track that has already failed its retry.
    const wanted = usePlayer.getState().wantsPlay;
    usePlayer.setState({ error: `Couldn't play "${cur.title}"`, status: "paused", wantsPlay: false });
    skipAfterError(wanted);
  },
};

const EVENTS: ElementEventType[] = ["timeupdate", "loadedmetadata", "durationchange", "seeking", "play", "playing", "pause", "waiting", "ended", "error", "canplay", "canplaythrough"];
audioEls.forEach((el, i) => {
  for (const type of EVENTS) {
    el.addEventListener(type, () => {
      const route = routeElementEvent(elementRole(i, activeIdx, tx), type);
      switch (route) {
        case "store": storeHandlers[type]?.(el); return;
        case "canPlay":
          // Only for the source this preload set; primed once, from its metadata on (WebKit may
          // not buffer a paused element further, and priming makes it load).
          if (el.src === preloadUrl && el.readyState >= HTMLMediaElement.HAVE_METADATA && primedUrl !== el.src) prime(el);
          return;
        case "failed": dispatch({ type: "failed" }); preloadUrl = null; release(el); return;
        case "fadeDone": finishFade(); return;
        case "fadeTick": fadeTick(); return;
        default: return;
      }
    });
  }
});

/** The element playing the current track (selftest, persistence; only this module changes it). */
export const activeAudio = () => active();
/** audio.paused, for the selftest's record of a toggle (only this module touches the elements). */
export const elementPaused = () => active().paused;
/** The active element's playhead, for the saved play state. */
export const playbackPosition = () => active().currentTime;
/** The transition machinery's state, for the selftest and the browser-mode measurements. */
export const transitionInfo = () => ({
  phase: tx.phase, active: activeIdx, transitions: transitions.slice(),
  volumes: [audioEls[0].volume, audioEls[1].volume], paused: [audioEls[0].paused, audioEls[1].paused],
});

// Exposed for diagnostics: __bcAudio is always the active element.
Object.defineProperty(window, "__bcAudio", { get: active, configurable: true });
(window as unknown as { __bcPlayer?: unknown }).__bcPlayer = {
  elements: audioEls,
  info: transitionInfo,
  // Dev builds only: compare starting on "ended" (null) with an early start, and mute both
  // elements for a silent Playwright run (priming and release restore this, not unmuted).
  ...(import.meta.env.DEV ? {
    store: usePlayer, // the app's own instance (an import from a test can get a second one after HMR)
    setStartLead: (ms: number | null) => { startLeadMs = ms; },
    mute: () => audioEls.forEach((el, i) => { baseMuted[i] = true; el.muted = true; }),
  } : {}),
};
