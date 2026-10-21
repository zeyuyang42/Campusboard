import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { cachedFetchText } from "./pageCache.js";
import { RADIO_CDN_URL } from "../scrape/radio.js";
import { STREAM_REFRESH_ENDPOINT } from "../scrape/discover.js";
import { parseTralbumPage, streamExpiry, type ParsedTralbum } from "../scrape/parseTralbum.js";
import { ScrapeError } from "../scrape/errors.js";
import { isFetchableBandcampUrl } from "../scrape/url.js";
import { PAGE_CACHE_MS, STREAM_SAFETY_MS } from "../config.js";
import type { DiscoverItem, QueuePreview, QueueTrack } from "../types.js";

/** Preview ids are -(PREVIEW_ID_BASE + track id): below every radio id (-showId) there is. */
export const PREVIEW_ID_BASE = 1e10;
export const previewQueueId = (trackId: number) => -(PREVIEW_ID_BASE + trackId);

/**
 * A queue entry for a Discover result's featured track (#104), or null when it has none.
 * Its id and album_id are negative (previewQueueId), so it never matches a library track,
 * is never counted in listening history and can't go into a playlist.
 */
export function previewQueueTrack(i: DiscoverItem): QueueTrack | null {
  const f = i.featured;
  if (!f) return null;
  const id = previewQueueId(f.track_id);
  return {
    id, track_id: id, album_id: id, title: f.title, track_num: null, duration: f.duration,
    track_artist: f.artist && f.artist !== i.artist ? f.artist : null, streamable: true, lyrics: null,
    album_title: i.title, artist_name: i.artist, art_id: i.art_id, album_url: i.url,
    preview: { item_url: i.url, track_id: f.track_id, stream_url: f.stream_url },
  };
}

/**
 * Preview entries for a whole release page (search and Browse, see core.previewRelease):
 * every track with an mp3-128 stream on the CDN, in album order (a pre-order's unreleased
 * tracks have none and are left out). Same ids as previewQueueTrack, so a Discover preview
 * and the same track previewed from Search are one entry. `start` is the featured track's
 * index, or 0 when the page names none (or it has no stream).
 */
export function previewReleaseTracks(p: ParsedTralbum): { tracks: QueueTrack[]; start: number } {
  const tracks: QueueTrack[] = [];
  for (const t of p.tracks) {
    if (!t.streamable || !t.stream_url || t.stream_quality !== "mp3-128" || !RADIO_CDN_URL.test(t.stream_url)) continue;
    const id = previewQueueId(t.track_id);
    tracks.push({
      id, track_id: id, album_id: id, title: t.title, track_num: t.track_num, duration: t.duration,
      track_artist: t.artist && t.artist !== p.artist.name ? t.artist : null, streamable: true, lyrics: null,
      album_title: p.title, artist_name: p.artist.name, art_id: p.art_id, album_url: p.url,
      preview: { item_url: p.url, track_id: t.track_id, stream_url: t.stream_url },
    });
  }
  const f = p.featured_track_id == null ? -1 : tracks.findIndex((t) => t.preview?.track_id === p.featured_track_id);
  return { tracks, start: Math.max(0, f) };
}

export const isPreviewTrack = (t: object | null | undefined): boolean => !!(t as { preview?: unknown } | null | undefined)?.preview;

/** A restored queue entry's `preview` field, if it has the shape previewQueueTrack gives it. */
export function isQueuePreview(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return typeof p.track_id === "number" && Number.isInteger(p.track_id) && p.track_id > 0 &&
    typeof p.item_url === "string" && isFetchableBandcampUrl(p.item_url) &&
    typeof p.stream_url === "string" && RADIO_CDN_URL.test(p.stream_url);
}

/**
 * Stream URLs for Discover previews. The URL discover gave is used until STREAM_SAFETY_MS
 * before its `ts` expiry; then (or on `force`, the player's retry after a media error)
 * Bandcamp's refresh endpoint gives a new one, and if that fails the release page is read
 * and the featured track picked from its data-tralbum. Every URL must be on the stream CDN.
 * Refreshed URLs are kept in memory by track id, so a restored queue doesn't refresh twice.
 */
export class PreviewService {
  private fresh = new Map<number, { url: string; expires_at: number }>();

  constructor(private db: Db, private queue: FetchQueue) {}

  async streamUrl(p: QueuePreview, force = false): Promise<{ url: string; expires_at: number }> {
    if (!Number.isInteger(p.track_id) || p.track_id <= 0) throw new ScrapeError("not_streamable", "Not a Bandcamp track");
    const now = Date.now();
    if (!force) {
      const hit = this.fresh.get(p.track_id);
      if (hit && hit.expires_at - now > STREAM_SAFETY_MS) return hit;
      if (RADIO_CDN_URL.test(p.stream_url)) {
        const exp = streamExpiry(p.stream_url, now);
        if (exp - now > STREAM_SAFETY_MS) return { url: p.stream_url, expires_at: exp };
      }
    }
    this.fresh.delete(p.track_id);
    let url: string | null = null;
    try {
      url = await this.refresh(p);
    } catch (e) {
      // During a challenge cooldown the page read would fail the same way.
      if (e instanceof ScrapeError && e.code === "challenge_cooldown") throw e;
      url = null;
    }
    url ??= await this.fromPage(p, force);
    const r = { url, expires_at: streamExpiry(url, Date.now()) };
    if (this.fresh.size >= 500) this.fresh.clear();
    this.fresh.set(p.track_id, r);
    return r;
  }

  /** GET api/stream/1/refresh?url=<stream_url> -> { track_id, url }. */
  private async refresh(p: QueuePreview): Promise<string | null> {
    if (!RADIO_CDN_URL.test(p.stream_url)) return null;
    const text = await this.queue.fetchText(`${STREAM_REFRESH_ENDPOINT}?url=${encodeURIComponent(p.stream_url)}`, { headers: { Accept: "application/json" } }, 0);
    let j: unknown;
    try { j = JSON.parse(text); } catch { return null; }
    const o = j as { url?: unknown; track_id?: unknown } | null;
    if (!o || typeof o.url !== "string" || !RADIO_CDN_URL.test(o.url)) return null;
    if (o.track_id != null && Number(o.track_id) !== p.track_id) return null;
    return o.url;
  }

  /** The release page's stream URL for the featured track. */
  private async fromPage(p: QueuePreview, force: boolean): Promise<string> {
    if (!isFetchableBandcampUrl(p.item_url)) throw new ScrapeError("not_streamable", "Not a Bandcamp release");
    const parsed = parseTralbumPage(await cachedFetchText(this.db, this.queue, p.item_url, force ? 0 : PAGE_CACHE_MS));
    const t = parsed.tracks.find((x) => x.track_id === p.track_id);
    const url = t?.stream_url ?? null;
    if (!t || !url) throw new ScrapeError("not_streamable", `"${parsed.title}" has no stream for this track`);
    if (!RADIO_CDN_URL.test(url)) throw new ScrapeError("not_streamable", "The stream is outside Bandcamp's CDN");
    return url;
  }
}
