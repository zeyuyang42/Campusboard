import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { cachedFetchText } from "./pageCache.js";
import { parseRadioList, parseRadioShow, radioShowUrl, RADIO_LIST_URL, type ParsedRadioShow } from "../scrape/radio.js";
import { ScrapeError } from "../scrape/errors.js";
import { PAGE_CACHE_MS } from "../config.js";
import type { QueueTrack, RadioShow, RadioShowSummary } from "../types.js";

/** The show list changes when a new episode is published (two or three a week): read it once a day. */
export const RADIO_LIST_CACHE_MS = 24 * 60 * 60 * 1000;
/**
 * How long an episode's stream_redirect URL is trusted after Bandcamp issued it (its `ts=`).
 * It is signed; one 25 minutes old still redirected when checked (2026-10-19). The page
 * cache hands out URLs at most PAGE_CACHE_MS old, and a media error refetches the page.
 */
export const RADIO_STREAM_TTL_MS = 60 * 60 * 1000;

/** Issue time of a stream_redirect URL plus the TTL, or `fetchedAt` plus the TTL without one. */
export function radioStreamExpiry(url: string, fetchedAt: number): number {
  const m = url.match(/[?&]ts=(\d+)/);
  return (m ? Number(m[1]) * 1000 : fetchedAt) + RADIO_STREAM_TTL_MS;
}

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

export const isRadioTrack = (t: { id: number; radio?: unknown } | null | undefined): boolean => !!t && (!!t.radio || t.id < 0);

/**
 * Bandcamp Radio for one core: the show list, episode tracklists and their audio URLs.
 * Every page goes through the queue and the page cache. Parsed episodes are also kept in
 * memory (a tracklist never changes), so reopening Now Playing costs no request.
 */
export class RadioService {
  private shows = new Map<number, ParsedRadioShow>();
  private inflight = new Map<number, Promise<ParsedRadioShow>>();

  constructor(private db: Db, private queue: FetchQueue) {}

  /** The latest episodes, newest first (one request a day at most). */
  async list(): Promise<RadioShowSummary[]> {
    return parseRadioList(await cachedFetchText(this.db, this.queue, RADIO_LIST_URL, RADIO_LIST_CACHE_MS));
  }

  /** An episode with its tracklist, each entry marked with its library album id if imported. */
  async show(showId: number): Promise<RadioShow> {
    const s = this.shows.get(showId) ?? await this.fetchShow(showId, PAGE_CACHE_MS);
    const rows = await this.db.select<{ id: number; url: string }>("SELECT id, url FROM albums");
    const byUrl = new Map(rows.map((r) => [r.url, r.id]));
    return {
      id: s.id, title: s.title, program: s.program, date: s.date, description: s.description, image_id: s.image_id,
      url: s.url, duration: s.duration, tracks: s.tracks.map((t) => ({ ...t, album_id: t.url ? byUrl.get(t.url) ?? null : null })),
    };
  }

  /**
   * The episode's audio URL. A page read in the last PAGE_CACHE_MS is reused unless `force`
   * (the player's retry after a media error), which reads it again.
   */
  async streamUrl(showId: number, force = false): Promise<{ url: string; expires_at: number }> {
    const s = await this.fetchShow(showId, force ? 0 : PAGE_CACHE_MS);
    if (!s.stream_url) throw new ScrapeError("not_streamable", `"${s.title}" has no audio on Bandcamp`);
    return { url: s.stream_url, expires_at: radioStreamExpiry(s.stream_url, Date.now()) };
  }

  /** Deduped per show, so the player's load and Now Playing's tracklist share one request. */
  private fetchShow(showId: number, maxAge: number): Promise<ParsedRadioShow> {
    if (!Number.isInteger(showId) || showId <= 0) return Promise.reject(new ScrapeError("not_found", `No radio show ${showId}`));
    // A forced read (maxAge 0) never reuses one in flight: that one may be the cached copy.
    let p = maxAge > 0 ? this.inflight.get(showId) : undefined;
    if (!p) {
      p = (async () => {
        const s = parseRadioShow(await cachedFetchText(this.db, this.queue, radioShowUrl(showId), maxAge));
        this.shows.set(showId, s);
        return s;
      })().finally(() => this.inflight.delete(showId));
      this.inflight.set(showId, p);
    }
    return p;
  }
}
