import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { cachedFetchText } from "./pageCache.js";
import { parseRadioList, parseRadioShow, radioShowUrl, RADIO_CDN_URL, RADIO_LIST_URL, type ParsedRadioShow } from "../scrape/radio.js";
import { streamExpiry } from "../scrape/parseTralbum.js";
import { ScrapeError } from "../scrape/errors.js";
import { PAGE_CACHE_MS, STREAM_SAFETY_MS } from "../config.js";
import type { QueueTrack, RadioShow, RadioShowSummary } from "../types.js";

/** The show list changes when a new episode is published (two or three a week): read it once a day. */
export const RADIO_LIST_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * A queue entry for an episode: one long track. Its id and album_id are minus the show id,
 * so it can't collide with a library track (ids are positive) and two episodes never count
 * as one album for crossfades.
 */
export function radioQueueTrack(s: Pick<RadioShow, "id" | "title" | "program" | "image_id" | "url"> & { duration?: number | null }): QueueTrack {
  return {
    id: -s.id, track_id: -s.id, album_id: -s.id, title: s.title, track_num: null, duration: s.duration ?? null,
    track_artist: null, streamable: true, lyrics: null, album_title: "Bandcamp Radio", artist_name: s.program,
    art_id: null, album_url: s.url, radio: { show_id: s.id, image_id: s.image_id, program: s.program },
  };
}

/** A radio episode: its `radio` field, or (older saved queues) a negative id that isn't a Discover preview. */
export const isRadioTrack = (t: { id: number; radio?: unknown; preview?: unknown } | null | undefined): boolean => !!t && (!!t.radio || (t.id < 0 && !t.preview));

/** A restored queue entry's `radio` field, if it has the shape radioQueueTrack gives it. */
export function isQueueRadio(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.show_id === "number" && Number.isInteger(r.show_id) && r.show_id > 0 &&
    (r.image_id === null || (typeof r.image_id === "number" && Number.isInteger(r.image_id) && r.image_id > 0)) &&
    typeof r.program === "string";
}

/**
 * Bandcamp Radio for one core: the show list, episode tracklists and their audio URLs.
 * Every request goes through the queue (pages also through the page cache). Parsed episodes
 * are kept in memory (a tracklist never changes), so reopening Now Playing costs no request,
 * and so are resolved audio URLs until they near their expiry.
 */
export class RadioService {
  private shows = new Map<number, ParsedRadioShow>();
  private inflight = new Map<number, Promise<ParsedRadioShow>>();
  private streams = new Map<number, { url: string; expires_at: number }>();

  constructor(private db: Db, private queue: FetchQueue) {}

  /** The latest episodes, newest first (one request a day at most). */
  async list(): Promise<RadioShowSummary[]> {
    return parseRadioList(await cachedFetchText(this.db, this.queue, RADIO_LIST_URL, RADIO_LIST_CACHE_MS));
  }

  /** An episode with its tracklist, each entry marked with its library album id if imported. */
  async show(showId: number): Promise<RadioShow> {
    const s = this.shows.get(showId) ?? await this.fetchShow(showId, PAGE_CACHE_MS);
    const urls = [...new Set(s.tracks.map((t) => t.url).filter((u): u is string => !!u))];
    const rows = urls.length
      ? await this.db.select<{ id: number; url: string }>(`SELECT id, url FROM albums WHERE url IN (${urls.map(() => "?").join(", ")})`, urls)
      : [];
    const byUrl = new Map(rows.map((r) => [r.url, r.id]));
    return {
      id: s.id, title: s.title, program: s.program, date: s.date, description: s.description, image_id: s.image_id,
      url: s.url, duration: s.duration, tracks: s.tracks.map((t) => ({ ...t, album_id: t.url ? byUrl.get(t.url) ?? null : null })),
    };
  }

  /**
   * The episode's audio as a bcbits CDN URL. The page's stream_redirect is resolved here,
   * through the queue and without following it, so the <audio> element only ever talks to
   * the CDN and the URL carries its real `ts` expiry (~24 h). A resolved URL is reused until
   * STREAM_SAFETY_MS before that; `force` (the player's retry after a media error) reads the
   * page again and resolves afresh.
   */
  async streamUrl(showId: number, force = false): Promise<{ url: string; expires_at: number }> {
    const hit = this.streams.get(showId);
    if (!force && hit && hit.expires_at - Date.now() > STREAM_SAFETY_MS) return hit;
    this.streams.delete(showId);
    let url: string;
    try {
      url = await this.resolve(await this.fetchShow(showId, force ? 0 : PAGE_CACHE_MS));
    } catch (e) {
      // A redirect from a cached page may have gone stale (it is signed): read the page once more.
      if (force || !(e instanceof ScrapeError && e.code === "not_found")) throw e;
      url = await this.resolve(await this.fetchShow(showId, 0));
    }
    const r = { url, expires_at: streamExpiry(url, Date.now()) };
    this.streams.set(showId, r);
    return r;
  }

  private async resolve(s: ParsedRadioShow): Promise<string> {
    if (!s.stream_url) throw new ScrapeError("not_streamable", `"${s.title}" has no audio on Bandcamp`);
    const url = await this.queue.resolveRedirect(s.stream_url);
    if (!RADIO_CDN_URL.test(url)) throw new ScrapeError("not_streamable", `"${s.title}" redirected outside Bandcamp's stream CDN`);
    return url;
  }

  /** Deduped per show, so the player's load and Now Playing's tracklist share one request. */
  private fetchShow(showId: number, maxAge: number): Promise<ParsedRadioShow> {
    if (!Number.isInteger(showId) || showId <= 0) return Promise.reject(new ScrapeError("not_found", `No radio show ${showId}`));
    // A forced read (maxAge 0) never reuses one in flight: that one may be the cached copy.
    let p = maxAge > 0 ? this.inflight.get(showId) : undefined;
    if (!p) {
      const read: Promise<ParsedRadioShow> = (async () => {
        const s = parseRadioShow(await cachedFetchText(this.db, this.queue, radioShowUrl(showId), maxAge));
        this.shows.set(showId, s);
        return s;
      })().finally(() => { if (this.inflight.get(showId) === read) this.inflight.delete(showId); });
      this.inflight.set(showId, read);
      p = read;
    }
    return p;
  }
}
