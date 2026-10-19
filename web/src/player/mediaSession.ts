// Now Playing widget, media keys and AirPods through the Media Session API.
//
// WKWebView (Media Session on by default since WebKit 612 / Safari 15) publishes the
// metadata below for the app's <audio> element to MediaRemote, the service behind
// MPNowPlayingInfoCenter, and routes the system's remote commands (F7-F9, Control Center,
// AirPods) to the action handlers. It keeps working with the window hidden: the page is
// not suspended while it plays. No native bridge is needed; see AGENTS.md.
//
// Handlers only call player store actions, and the state comes from the store, never from
// the audio element.
import { finiteDuration, nowPlayingMetadata, positionState, PositionThrottle, radioEntryAt, sessionPlaybackState, type RadioEntry, type SessionPlaybackState } from "@bc/core";
import { usePlayer } from "./store";
import { getCore } from "../api/core";

const ACTIONS = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const;
type Action = (typeof ACTIONS)[number];
const SEEK_STEP_SEC = 10;

const registered: Action[] = [];
const handlers = new Map<Action, MediaSessionActionHandler>();
let positionReports = 0;
let lastPosition: { duration: number; position: number; playbackRate: number } | null = null;

function handlerFor(action: Action): MediaSessionActionHandler {
  const s = () => usePlayer.getState();
  switch (action) {
    case "play": return () => s().play();
    case "pause": return () => s().pause();
    case "previoustrack": return () => s().prev();
    case "nexttrack": return () => s().next();
    case "seekto": return (d) => { if (d.seekTime != null && Number.isFinite(d.seekTime)) s().seek(d.seekTime); };
    case "seekbackward": return (d) => s().seekBy(-(d.seekOffset || SEEK_STEP_SEC));
    case "seekforward": return (d) => s().seekBy(d.seekOffset || SEEK_STEP_SEC);
  }
}

/** What the session was given, for the selftest and the Playwright check. */
export function mediaSessionInfo() {
  const ms = "mediaSession" in navigator ? navigator.mediaSession : null;
  return {
    supported: !!ms,
    actions: registered.slice(),
    title: ms?.metadata?.title ?? null,
    artist: ms?.metadata?.artist ?? null,
    album: ms?.metadata?.album ?? null,
    artwork: ms?.metadata?.artwork.map((a) => a.src) ?? [],
    playbackState: ms?.playbackState ?? null,
    lastPosition,
    positionReports,
  };
}

/**
 * Run the handler registered for `action` as the system would (selftest and Playwright only;
 * nothing in the app calls it). False if the action isn't registered.
 */
export function runMediaSessionAction(action: Action, details: Partial<MediaSessionActionDetails> = {}): boolean {
  const h = handlers.get(action);
  if (!h) return false;
  h({ action, ...details } as MediaSessionActionDetails);
  return true;
}

let started = false;
export function initMediaSession() {
  if (started || !("mediaSession" in navigator)) return;
  started = true;
  const ms = navigator.mediaSession;
  for (const action of ACTIONS) {
    try {
      const h = handlerFor(action);
      ms.setActionHandler(action, h);
      handlers.set(action, h);
      registered.push(action);
    } catch { /* this WebKit doesn't know the action */ }
  }

  const throttle = new PositionThrottle();
  let lastId: number | null = null;
  let state: SessionPlaybackState = "none";
  // A radio episode (#44): its tracklist, read once per episode (core keeps it in memory), so
  // the artist line can follow the featured track. Metadata changes only when that does.
  let radioFor: number | null = null;
  let radioTracks: RadioEntry[] | null = null;
  let lastEntry = -1;
  const sync = (s: ReturnType<typeof usePlayer.getState>) => {
    const cur = s.queue[s.index] ?? null;
    const showId = cur?.radio?.show_id ?? null;
    if (showId !== radioFor) {
      radioFor = showId;
      radioTracks = null;
      if (showId) {
        void getCore().then((c) => c.radioShow(showId)).then((show) => {
          if (radioFor !== showId) return;
          radioTracks = show.tracks;
          sync(usePlayer.getState());
        }).catch(() => undefined); // no tracklist: the programme stays as the artist line
      }
    }
    const entry = radioTracks ? radioEntryAt(radioTracks, s.position) : -1;
    if ((cur?.id ?? null) !== lastId) {
      lastId = cur?.id ?? null;
      lastEntry = entry;
      throttle.reset();
      lastPosition = null;
      try { ms.setPositionState(); } catch { /* ignore */ }
      ms.metadata = cur ? new MediaMetadata(nowPlayingMetadata(cur, radioTracks?.[entry])) : null;
    } else if (cur?.radio && entry !== lastEntry) {
      lastEntry = entry;
      ms.metadata = new MediaMetadata(nowPlayingMetadata(cur, radioTracks?.[entry]));
    }
    // Buffering mid-track (a "waiting" stall): the playhead isn't moving.
    const midTrack = s.status === "loading" && s.position > 0 && Number.isFinite(s.duration) && s.duration > 0;
    const next = sessionPlaybackState(s.status, !!cur, state, midTrack);
    if (next !== state) ms.playbackState = state = next;
    if (!cur) return;
    // This player has no rate control: the rate is always 1.
    const pos = positionState(finiteDuration(s.duration, cur.duration), s.position, 1);
    // The throttle follows the real status: not playing while loading or buffering.
    if (pos && throttle.next(pos, s.status === "playing", performance.now())) {
      try {
        ms.setPositionState(pos);
        lastPosition = pos;
        positionReports++;
      } catch { /* rejected by this WebKit; the element's own position is used instead */ }
    }
  };
  usePlayer.subscribe(sync);
  sync(usePlayer.getState());
}

// Exposed for diagnostics, like window.__bcAudio.
(window as unknown as { __bcMediaSession?: unknown }).__bcMediaSession = { info: mediaSessionInfo, run: runMediaSessionAction };
