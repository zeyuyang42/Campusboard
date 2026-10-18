/**
 * What the app tells the system Now Playing widget (Control Center, the menu bar, the media
 * keys, AirPods) through `navigator.mediaSession`. WebKit publishes it to MediaRemote, the
 * service behind MPNowPlayingInfoCenter, for the app's <audio> element. Pure and DOM-free so
 * it can be tested in Node; web/src/player/mediaSession.ts applies it.
 */
import { artUrl, type ArtSize } from "../palette/index.js";
import type { QueueTrack } from "../types.js";

export interface NowPlayingArtwork { src: string; sizes: string; type: string }
export interface NowPlayingMetadata { title: string; artist: string; album: string; artwork: NowPlayingArtwork[] }
export type SessionPlaybackState = "none" | "paused" | "playing";
export type PlayerStatus = "idle" | "loading" | "playing" | "paused";
export interface PositionState { duration: number; position: number; playbackRate: number }

/**
 * Art CDN sizes offered to WebKit, preferred first. WebKit before 2024 (macOS 13/14) loads
 * artwork[0] only ("FIXME: Implement a heuristic"); newer WebKit scores the `sizes` and
 * prefers the one nearest 512px, which is 700 too. 1200 would be a wasted large download.
 */
const ARTWORK_SIZES: { size: ArtSize; px: number }[] = [
  { size: 16, px: 700 },
  { size: 2, px: 350 },
  { size: 10, px: 1200 },
  { size: 7, px: 160 },
];

export function nowPlayingMetadata(t: Pick<QueueTrack, "title" | "track_artist" | "artist_name" | "album_title" | "art_id">): NowPlayingMetadata {
  const artwork: NowPlayingArtwork[] = [];
  for (const { size, px } of ARTWORK_SIZES) {
    const src = artUrl(t.art_id, size);
    if (src) artwork.push({ src, sizes: `${px}x${px}`, type: "image/jpeg" });
  }
  return { title: t.title, artist: t.track_artist || t.artist_name || "", album: t.album_title || "", artwork };
}

/**
 * The session's playbackState for a player status. "loading" (a track change or a stall)
 * keeps the previous state, so Next while playing never flashes the widget to paused. From
 * nothing it is "playing": only playTracks loads from idle, and it always autoplays.
 */
export function sessionPlaybackState(status: PlayerStatus, hasTrack: boolean, prev: SessionPlaybackState): SessionPlaybackState {
  if (!hasTrack || status === "idle") return "none";
  if (status === "playing") return "playing";
  if (status === "paused") return "paused";
  return prev === "none" ? "playing" : prev;
}

/** A usable duration in seconds: the media's when finite and positive, else the scraped one, else null. */
export function finiteDuration(media: number | null | undefined, fallback: number | null | undefined): number | null {
  if (typeof media === "number" && Number.isFinite(media) && media > 0) return media;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}

/**
 * A position state WebKit accepts (setPositionState throws a TypeError unless
 * 0 <= position <= duration and the rate is finite and non-zero), or null when there is
 * no usable duration yet.
 */
export function positionState(duration: number | null, position: number, rate: number): PositionState | null {
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return null;
  const pos = Number.isFinite(position) ? Math.max(0, Math.min(position, duration)) : 0;
  const playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return { duration, position: pos, playbackRate };
}

/**
 * Decides when to call setPositionState. The system extrapolates the position from the last
 * report and the rate while playing, so steady playback needs no reports: only a new
 * duration or rate, a play/pause change, a jump (seek, restart, repeat-one) or a periodic
 * resync to correct drift.
 */
export class PositionThrottle {
  private last: { state: PositionState; playing: boolean; at: number } | null = null;

  constructor(
    /** Resync at most this often (ms) when nothing else changed. */
    readonly resyncMs = 10_000,
    /** A position off the extrapolated one by more than this (seconds) is a jump. */
    readonly jumpSec = 1.5,
  ) {}

  /** True when `state` should be reported now; remembers it as the last report if so. */
  next(state: PositionState, playing: boolean, nowMs: number): boolean {
    const l = this.last;
    let report = !l;
    if (l) {
      const elapsed = Math.max(0, nowMs - l.at) / 1000;
      const expected = Math.min(l.state.position + (l.playing ? elapsed * l.state.playbackRate : 0), l.state.duration);
      report =
        state.duration !== l.state.duration ||
        state.playbackRate !== l.state.playbackRate ||
        playing !== l.playing ||
        Math.abs(state.position - expected) > this.jumpSec ||
        nowMs - l.at >= this.resyncMs;
    }
    if (report) this.last = { state, playing, at: nowMs };
    return report;
  }

  /** Forget the last report (a new track): the next state is always reported. */
  reset() { this.last = null; }
}
