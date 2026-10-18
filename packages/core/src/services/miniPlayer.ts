// The mini player window's protocol. The main window owns the audio element and the player
// store; it broadcasts a compact MiniState to the `mini` window and maps the MiniCommands it
// sends back to store actions. Both directions cross a window boundary, so each side
// validates what it receives. Pure: no DOM, no Tauri.

/** Event names. Directional, so neither window ever handles its own messages. */
export const MINI_EVENTS = {
  /** main -> mini: MiniState */
  state: "mini:state",
  /** mini -> main: MiniCommand */
  command: "mini:command",
} as const;

export type MiniStatus = "idle" | "loading" | "playing" | "paused";

export interface MiniTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  artId: number | null;
}

/** The art-fitted colors the main window paints on :root (see web/src/theme/usePalette.ts). */
export interface MiniPalette {
  accent: string;
  accentText: string;
  ambient1: string;
  ambient2: string;
}

export interface MiniState {
  track: MiniTrack | null;
  status: MiniStatus;
  /** Seconds; the mini window extrapolates between reports while playing. */
  position: number;
  /** Seconds, 0 when unknown. */
  duration: number;
  palette: MiniPalette | null;
  /** The main window's theme, re-validated with parseTheme on the mini side. */
  theme: unknown;
}

export type MiniCommand =
  | { type: "hello" } // the mini window opened or became visible: send the full state now
  | { type: "bye" } // the mini window was hidden: stop sending until the next hello
  | { type: "toggle" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; sec: number }
  | { type: "showMain" };

const SIMPLE = new Set(["hello", "bye", "toggle", "play", "pause", "next", "prev", "showMain"]);
/** Longer than any track; the store clamps to the real duration anyway. */
const MAX_SEEK_SEC = 24 * 3600;
const STATUSES = new Set<string>(["idle", "loading", "playing", "paused"]);
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const MAX_TEXT = 300;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const finiteNonNeg = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const text = (x: unknown) => (typeof x === "string" ? x.slice(0, MAX_TEXT) : null);

/** A command from the mini window, or null if it isn't one. Extra fields are dropped. */
export function parseMiniCommand(x: unknown): MiniCommand | null {
  if (!isObj(x) || typeof x.type !== "string") return null;
  if (x.type === "seek") {
    const sec = finiteNonNeg(x.sec);
    return sec == null ? null : { type: "seek", sec: Math.min(sec, MAX_SEEK_SEC) };
  }
  return SIMPLE.has(x.type) ? ({ type: x.type } as MiniCommand) : null;
}

function parsePalette(x: unknown): MiniPalette | null {
  if (!isObj(x)) return null;
  const keys = ["accent", "accentText", "ambient1", "ambient2"] as const;
  if (!keys.every((k) => typeof x[k] === "string" && HEX.test(x[k] as string))) return null;
  return { accent: x.accent as string, accentText: x.accentText as string, ambient1: x.ambient1 as string, ambient2: x.ambient2 as string };
}

function parseTrack(x: unknown): MiniTrack | null {
  if (!isObj(x)) return null;
  const id = x.id, title = text(x.title), artist = text(x.artist), album = text(x.album);
  if (typeof id !== "number" || !Number.isInteger(id) || title == null || artist == null || album == null) return null;
  const artId = typeof x.artId === "number" && Number.isInteger(x.artId) && x.artId > 0 ? x.artId : null;
  return { id, title, artist, album, artId };
}

/**
 * The state from the main window, or null if it isn't one. Colors must be hex (they only
 * ever reach style.setProperty); numbers must be finite; text is capped.
 */
export function parseMiniState(x: unknown): MiniState | null {
  if (!isObj(x) || typeof x.status !== "string" || !STATUSES.has(x.status)) return null;
  const track = x.track == null ? null : parseTrack(x.track);
  if (x.track != null && !track) return null;
  const duration = finiteNonNeg(x.duration) ?? 0;
  const pos = finiteNonNeg(x.position) ?? 0;
  const position = duration ? Math.min(pos, duration) : pos;
  return { track, status: x.status as MiniStatus, position, duration, palette: parsePalette(x.palette), theme: x.theme ?? null };
}

/** What buildMiniState reads from the player store (a structural subset of its state). */
export interface MiniSource {
  queue: readonly { id: number; title: string; artist_name: string; track_artist?: string | null; album_title: string; art_id: number | null }[];
  index: number;
  status: MiniStatus;
  position: number;
  duration: number;
}

export function buildMiniState(s: MiniSource, palette: MiniPalette | null, theme: unknown): MiniState {
  const t = s.queue[s.index];
  const duration = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0;
  const pos = Number.isFinite(s.position) && s.position > 0 ? s.position : 0;
  return {
    track: t ? { id: t.id, title: t.title, artist: t.track_artist || t.artist_name, album: t.album_title, artId: t.art_id ?? null } : null,
    status: t ? s.status : "idle",
    position: duration ? Math.min(pos, duration) : pos,
    duration,
    palette,
    theme,
  };
}

/** Everything but the position: a change here is always sent at once. */
export function miniStateKey(s: MiniState): string {
  return JSON.stringify([s.track, s.status, s.duration, s.palette, s.theme]);
}

/**
 * Decides when the main window sends the state. Anything but the position goes out at once;
 * while playing, the position goes out once per `tickMs` (the mini window extrapolates in
 * between) or at once when it jumps (a seek, a restart). While not playing, any position
 * change is a jump.
 */
export class MiniStateThrottle {
  private last: { key: string; position: number; playing: boolean; at: number } | null = null;

  constructor(readonly tickMs = 1000, readonly jumpSec = 1.5) {}

  /** True when `state` should be sent now; remembers it as the last one sent if so. */
  next(state: MiniState, nowMs: number): boolean {
    const key = miniStateKey(state);
    const playing = state.status === "playing";
    const l = this.last;
    let send = !l;
    if (l) {
      const expected = l.position + (l.playing ? Math.max(0, nowMs - l.at) / 1000 : 0);
      send =
        key !== l.key ||
        (playing ? Math.abs(state.position - expected) > this.jumpSec || nowMs - l.at >= this.tickMs : state.position !== l.position);
    }
    if (send) this.last = { key, position: state.position, playing, at: nowMs };
    return send;
  }

  /** Forget the last state (the mini window asked for it): the next one is always sent. */
  reset() { this.last = null; }
}

/**
 * Whether the main window should be sending state after `cmd`: `hello` (opened or shown)
 * turns it on, `bye` (hidden) turns it off, anything else leaves it as it was. A command
 * from a window that never said hello doesn't turn it on either.
 */
export function miniLiveAfter(live: boolean, cmd: MiniCommand): boolean {
  if (cmd.type === "hello") return true;
  if (cmd.type === "bye") return false;
  return live;
}

/** The position to show `elapsedMs` after `state` arrived. */
export function extrapolatePosition(state: Pick<MiniState, "status" | "position" | "duration">, elapsedMs: number): number {
  const p = state.position + (state.status === "playing" ? Math.max(0, elapsedMs) / 1000 : 0);
  return state.duration ? Math.min(p, state.duration) : p;
}
