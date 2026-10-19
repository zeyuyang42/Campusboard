import { z } from "zod";
import { ScrapeError } from "./errors.js";
import { isChallengePage, pageTitle, readJsonAttr } from "./html.js";
import { normalizeBandcampUrl } from "./url.js";
import type { RadioEntry, RadioShow, RadioShowSummary } from "../types.js";

/**
 * Bandcamp Radio (verified 2026-10-19, see AGENTS.md). Both pages carry a `data-blob` JSON
 * attribute: bandcamp.com/radio lists the latest episodes in `appData.shows` (20 per page),
 * and an episode page (bandcamp.com/radio?show=<id> redirects to /radio/<programme>/<id>)
 * has `appData.show` with one compiled audio file and the featured tracks with timecodes.
 */
export const RADIO_LIST_URL = "https://bandcamp.com/radio";
export const radioShowUrl = (showId: number) => `https://bandcamp.com/radio?show=${showId}`;

const ORIGIN = "https://bandcamp.com";
const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

const ShowListSchema = z.object({
  appData: z.object({
    shows: z.array(z.object({
      itemId: z.number(),
      title: z.string(),
      franchiseName: str,
      date: str,
      description: str,
      imageId: num,
      itemUrl: str,
    }).passthrough()),
  }).passthrough(),
}).passthrough();

const ShowSchema = z.object({
  appData: z.object({
    show: z.object({
      itemId: z.number(),
      title: z.string(),
      subtitle: str,
      itemUrl: str,
      imageId: num,
      date: str,
      description: str,
      franchise: z.object({ title: str }).passthrough().nullable().optional(),
      compiledTrack: z.object({ streamUrl: z.string(), duration: num }).passthrough().nullable().optional(),
      tracks: z.array(z.object({
        title: z.string(),
        artistName: str,
        url: str,
        duration: num,
        artId: num,
        timecode: z.number(),
        album: z.object({ title: str, url: str, artId: num }).passthrough().nullable().optional(),
      }).passthrough()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

/** An episode page parsed: the summary and tracklist, plus the audio URL and when it was read. */
export interface ParsedRadioShow extends RadioShow {
  /** bandcamp.com/stream_redirect?...&ts=<issued>&t=<signature>; it 302s to the bcbits mp3-128 file. */
  stream_url: string | null;
}

function blob(html: string, what: string): unknown {
  if (isChallengePage(html)) throw new ScrapeError("client_challenge", "Bandcamp returned a bot challenge page");
  let raw: unknown;
  try {
    raw = readJsonAttr(html, "data-blob");
  } catch (e) {
    throw new ScrapeError("parse_failed", `${what}: data-blob is not valid JSON`, String(e));
  }
  if (!raw) throw new ScrapeError("parse_failed", `${what}: no data-blob attribute (title: ${pageTitle(html) ?? "?"})`);
  return raw;
}

const isoDate = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const positive = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
const showPage = (itemUrl: string | null | undefined, id: number) =>
  itemUrl && /^\/radio\//.test(itemUrl) ? `${ORIGIN}${itemUrl.replace(/\/+$/, "")}` : radioShowUrl(id);

/** A Bandcamp album or track URL in canonical form, or null if it isn't one. */
function itemUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const n = normalizeBandcampUrl(u);
    return n.kind === "artist" ? null : n.url;
  } catch {
    return null;
  }
}

/** The latest episodes from bandcamp.com/radio, newest first. */
export function parseRadioList(html: string): RadioShowSummary[] {
  const res = ShowListSchema.safeParse(blob(html, "Radio list"));
  if (!res.success) throw new ScrapeError("parse_failed", `Radio list schema mismatch: ${res.error.issues[0]?.path.join(".")}`);
  return res.data.appData.shows.map((s) => ({
    id: s.itemId,
    title: clean(s.title),
    program: clean(s.franchiseName) || "Bandcamp Radio",
    date: isoDate(s.date),
    description: clean(s.description) || null,
    image_id: positive(s.imageId),
    url: showPage(s.itemUrl, s.itemId),
  }));
}

/** One episode page: its audio and its featured tracks, sorted by timecode. */
export function parseRadioShow(html: string): ParsedRadioShow {
  const res = ShowSchema.safeParse(blob(html, "Radio show"));
  if (!res.success) throw new ScrapeError("parse_failed", `Radio show schema mismatch: ${res.error.issues[0]?.path.join(".")}`);
  const s = res.data.appData.show;
  const tracks: RadioEntry[] = s.tracks
    .filter((t) => Number.isFinite(t.timecode) && t.timecode >= 0)
    .map((t) => ({
      timecode: t.timecode,
      duration: positive(t.duration),
      title: clean(t.title),
      artist: clean(t.artistName),
      album_title: clean(t.album?.title) || null,
      art_id: positive(t.album?.artId) ?? positive(t.artId),
      url: itemUrl(t.album?.url) ?? itemUrl(t.url),
      album_id: null,
    }))
    .sort((a, b) => a.timecode - b.timecode);
  const stream = s.compiledTrack?.streamUrl ?? null;
  return {
    id: s.itemId,
    title: clean(s.title),
    program: clean(s.franchise?.title) || clean(s.subtitle) || "Bandcamp Radio",
    date: isoDate(s.date),
    description: clean(s.description) || null,
    image_id: positive(s.imageId),
    url: showPage(s.itemUrl, s.itemId),
    duration: positive(s.compiledTrack?.duration),
    // Only a Bandcamp-hosted stream: the CSP and the audio element trust nothing else.
    stream_url: stream && /^https:\/\/(bandcamp\.com|[a-z0-9-]+\.bcbits\.com)\//.test(stream) ? stream : null,
    tracks,
  };
}

/**
 * Index of the entry playing at `position` seconds: the last one whose timecode has been
 * reached, or -1 before the first (or for an empty list). `tracks` is sorted by timecode.
 */
export function radioEntryAt(tracks: readonly Pick<RadioEntry, "timecode">[], position: number): number {
  if (!Number.isFinite(position)) return -1;
  let lo = 0;
  let hi = tracks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tracks[mid].timecode <= position) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** A radio image (show art has no "a" prefix, unlike album art). */
export function radioImageUrl(imageId: number | null | undefined, size: number = 16): string | null {
  if (!imageId) return null;
  return `https://f4.bcbits.com/img/${String(imageId).padStart(10, "0")}_${size}.jpg`;
}
