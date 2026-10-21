import { z } from "zod";
import { postJson, type FetchQueue } from "./http.js";
import { ScrapeError } from "./errors.js";
import { hostOf, normalizeBandcampUrl, releaseUrlOrNull } from "./url.js";
import { clean } from "./html.js";
import { items, num, str } from "./schemas.js";
import { RADIO_CDN_URL } from "./radio.js";
import type { DiscoverItem, DiscoverLocation, DiscoverPage, DiscoverParams, DiscoverSlice, DiscoverTag } from "../types.js";

/**
 * Bandcamp discover (#104, verified 2026-10-21, see AGENTS.md). The /discover page carries
 * only its filters; the results come from a JSON POST that its Vue app makes, 60 a page,
 * paged with an opaque cursor. Each result names one featured track with a CDN stream URL.
 */
export const DISCOVER_ENDPOINT = "https://bandcamp.com/api/discover/1/discover_web";
export const TAG_SEARCH_ENDPOINT = "https://bandcamp.com/api/bcsearch_public_api/1/tag_search";
export const LOCATION_SEARCH_ENDPOINT = "https://bandcamp.com/api/location/1/geoname_search";
/** Gives a fresh URL for a featured track's stream_url: `{ track_id, url }`. */
export const STREAM_REFRESH_ENDPOINT = "https://bandcamp.com/api/stream/1/refresh";
export const DISCOVER_PAGE_SIZE = 60;

/** The page's `slices` (initialState), first is Bandcamp's default. */
export const DISCOVER_SLICES: readonly { slug: DiscoverSlice; label: string }[] = [
  { slug: "top", label: "Best-selling" },
  { slug: "new", label: "New arrivals" },
  { slug: "rand", label: "Surprise me" },
];
/**
 * The page's `times`. Bandcamp's default is -1 ("fresh"), sent as `time_facet_id: null`;
 * its links write the slug as `t=` (and read `t=` as a number), so both are accepted.
 */
export const DISCOVER_TIMES: readonly { id: number; slug: string; label: string }[] = [
  { id: -1, slug: "fresh", label: "Fresh" },
  { id: 0, slug: "today", label: "Today" },
  { id: 1, slug: "this-week", label: "This week" },
  { id: 2, slug: "1w", label: "Last week" },
  { id: 3, slug: "2w", label: "2 weeks ago" },
  { id: 4, slug: "3w", label: "3 weeks ago" },
  { id: 5, slug: "4w", label: "4 weeks ago" },
  { id: 6, slug: "5w", label: "5 weeks ago" },
  { id: 7, slug: "6w", label: "6 weeks ago" },
];
/**
 * The page's `categories` without t-shirts (no audio): `id` is discover_web's `category_id`,
 * `slug` the 2nd path segment of Bandcamp's links (/discover/<tags>/<slug>).
 */
export const DISCOVER_CATEGORIES: readonly { id: number; slug: string; label: string }[] = [
  { id: 0, slug: "all", label: "all categories" },
  { id: 1, slug: "digital", label: "digital" },
  { id: 2, slug: "vinyl", label: "vinyl" },
  { id: 3, slug: "cd", label: "compact discs" },
  { id: 4, slug: "cassette", label: "cassettes" },
];
export const DEFAULT_DISCOVER: DiscoverParams = { tags: [], slice: "top", time: null, location: null, category: 0 };
/** Bandcamp's tag input takes up to this many tags. */
export const DISCOVER_MAX_TAGS = 10;
/** Longer tags (from a link or the query) are dropped. */
export const DISCOVER_MAX_TAG_LENGTH = 64;

const ResultSchema = z.object({
  item_id: z.number().int().positive(),
  item_type: str,
  title: str,
  item_url: z.string(),
  band_name: str,
  band_url: str,
  release_date: str,
  track_count: num,
  is_album_preorder: z.unknown().optional(),
  primary_image: z.object({ image_id: num }).passthrough().nullable().optional(),
  featured_track: z.object({
    id: z.number().int().positive(),
    title: str,
    band_name: str,
    duration: num,
    stream_url: str,
  }).passthrough().nullable().optional(),
}).passthrough();

const ResponseSchema = z.object({
  results: z.array(z.unknown()),
  result_count: num,
  cursor: str,
}).passthrough();

const TagSchema = z.object({ norm_name: z.string().min(1), display_name: str, count: num }).passthrough();
const LocationSchema = z.object({ id: z.union([z.string(), z.number()]), name: str, fullname: str }).passthrough();

const post = (queue: FetchQueue, url: string, body: unknown, what: string) => postJson((u, i) => queue.fetchText(u, i), url, body, what);

function artistUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const n = normalizeBandcampUrl(u);
    return n.kind === "artist" ? n.url : null;
  } catch {
    return null;
  }
}

/** One result, or null when it has no usable release URL. */
export function parseDiscoverResult(x: unknown): DiscoverItem | null {
  const r = ResultSchema.safeParse(x);
  if (!r.success) return null;
  const d = r.data;
  // Canonical form: `?from=discover_page` dropped.
  const url = releaseUrlOrNull(d.item_url);
  if (!url) return null;
  const f = d.featured_track;
  const stream = f?.stream_url?.trim() ?? "";
  const art = d.primary_image?.image_id;
  const artist = clean(d.band_name);
  return {
    url,
    title: clean(d.title) || "Untitled",
    artist,
    artist_url: artistUrl(d.band_url),
    art_id: typeof art === "number" && art > 0 ? art : null,
    item_type: url.includes("/track/") ? "track" : "album",
    // "2026-09-04 00:00:00 UTC": just the day.
    release_date: d.release_date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    track_count: d.track_count != null && d.track_count > 0 ? Math.round(d.track_count) : null,
    preorder: d.is_album_preorder === true,
    // Only a URL on Bandcamp's stream CDN ever reaches the <audio> element.
    featured: f && RADIO_CDN_URL.test(stream) ? {
      track_id: f.id,
      title: clean(f.title) || clean(d.title) || "Untitled",
      artist: clean(f.band_name) || artist,
      duration: f.duration != null && f.duration > 0 ? f.duration : null,
      stream_url: stream,
    } : null,
    album_id: null,
  };
}

/** Parse a discover_web response (exported for tests). */
export function parseDiscoverResponse(raw: unknown): DiscoverPage {
  const res = ResponseSchema.safeParse(raw);
  if (!res.success) {
    const msg = raw && typeof raw === "object" && "error_message" in raw ? String((raw as { error_message: unknown }).error_message) : res.error.issues[0]?.path.join(".");
    throw new ScrapeError("parse_failed", `Discover response schema mismatch: ${msg}`);
  }
  const seen = new Set<string>();
  const items: DiscoverItem[] = [];
  for (const x of res.data.results) {
    const i = parseDiscoverResult(x);
    if (i && !seen.has(i.url)) { seen.add(i.url); items.push(i); }
  }
  const cursor = res.data.cursor && res.data.results.length ? res.data.cursor : null;
  return { items, total: res.data.result_count ?? items.length, cursor };
}

/** The request body Bandcamp's own page sends for these filters. */
export function discoverBody(p: DiscoverParams, cursor: string | null) {
  return {
    category_id: p.category,
    tag_norm_names: p.tags,
    geoname_id: p.location ?? 0,
    slice: p.slice,
    time_facet_id: p.time != null && p.time >= 0 ? p.time : null,
    cursor: cursor ?? "*",
    size: DISCOVER_PAGE_SIZE,
    // "t" makes the endpoint answer with an error (2026-10-21).
    include_result_types: ["a", "s"],
    followed_bands: false,
  };
}

/** One page of discover results: one POST through the queue. */
export async function discoverBatch(queue: FetchQueue, p: DiscoverParams, cursor: string | null = null): Promise<DiscoverPage> {
  return parseDiscoverResponse(await post(queue, DISCOVER_ENDPOINT, discoverBody(p, cursor), "Discover"));
}

/** Bandcamp's tag autocomplete. */
export async function tagSuggestions(queue: FetchQueue, prefix: string): Promise<DiscoverTag[]> {
  const raw = await post(queue, TAG_SEARCH_ENDPOINT, { prefix }, "Tag search");
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : null;
  if (!list) throw new ScrapeError("parse_failed", "Tag search response had no list");
  return items(list, TagSchema).map((t) => ({ norm_name: t.norm_name, display_name: clean(t.display_name) || t.norm_name, count: t.count ?? 0 }));
}

/** Bandcamp's place search (geonames ids, as the location filter takes them). */
export async function locationSuggestions(queue: FetchQueue, q: string): Promise<DiscoverLocation[]> {
  const raw = await post(queue, LOCATION_SEARCH_ENDPOINT, { q, n: 5, geocoder_fallback: false }, "Location search");
  const list = raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
  const out: DiscoverLocation[] = [];
  for (const l of items(list, LocationSchema)) {
    const id = Number(l.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.push({ id, label: clean(l.fullname) || clean(l.name) || String(id) });
  }
  return out;
}

const SLICE_SLUGS = new Set<string>(DISCOVER_SLICES.map((s) => s.slug));
/** A tag as Bandcamp's norm_name has it: lowercase words joined by dashes. */
const normTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-");

/** A `t=` value (an id or a slug) as a time facet id; null for the default or anything unknown. */
function timeOf(v: string | null): number | null {
  if (!v) return null;
  const t = DISCOVER_TIMES.find((x) => x.slug === v) ?? (/^-?\d+$/.test(v) ? DISCOVER_TIMES.find((x) => x.id === Number(v)) : undefined);
  return t && t.id >= 0 ? t.id : null;
}

/** A category slug as a category id; 0 (all) for anything else, numbers included. */
function categoryOf(v: string | null | undefined): number {
  return (v && DISCOVER_CATEGORIES.find((x) => x.slug === v)?.id) || 0;
}

/**
 * Filters from query parameters: `tags=a,b`, `s=<slice>`, `t=<time id or slug>`, `loc=<geoname id>`
 * (the same names Bandcamp's links use) and `cat=<category slug>` (Bandcamp has it in the
 * path). `extraTags` come first and `pathCategory` wins over `cat` (a discover link's path).
 */
export function discoverParamsFromQuery(q: URLSearchParams, extraTags: string[] = [], pathCategory?: string): DiscoverParams {
  const tags: string[] = [];
  for (const t of [...extraTags, ...(q.get("tags") ?? "").split(",")]) {
    const n = normTag(t);
    if (n && n.length <= DISCOVER_MAX_TAG_LENGTH && !tags.includes(n) && tags.length < DISCOVER_MAX_TAGS) tags.push(n);
  }
  const s = q.get("s") ?? "";
  const loc = Number(q.get("loc"));
  return {
    tags,
    slice: SLICE_SLUGS.has(s) ? (s as DiscoverSlice) : "top",
    time: timeOf(q.get("t")),
    location: Number.isInteger(loc) && loc > 0 ? loc : null,
    category: categoryOf(pathCategory) || categoryOf(q.get("cat")),
  };
}

/** The app's own /discover query for these filters (`s` always set, so it is never empty). */
export function discoverQuery(p: DiscoverParams): string {
  const q = new URLSearchParams();
  if (p.tags.length) q.set("tags", p.tags.join(","));
  q.set("s", p.slice);
  if (p.time != null) q.set("t", String(p.time));
  if (p.location) q.set("loc", String(p.location));
  const c = DISCOVER_CATEGORIES.find((x) => x.id === p.category);
  if (c && c.id) q.set("cat", c.slug);
  return q.toString();
}

/**
 * A bandcamp.com/discover link's filters, or null if it isn't one. The path is
 * /discover/<tag+tag…|all>[/<category>]: digital, vinyl, cd and cassette are honoured,
 * anything else there (tshirt…) means all categories.
 */
export function parseDiscoverUrl(input: string): DiscoverParams | null {
  let u: URL;
  try {
    const trimmed = input.trim();
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = hostOf(u);
  if (host !== "bandcamp.com" && host !== "www.bandcamp.com") return null;
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "discover") return null;
  const first = parts[1] && parts[1] !== "all" ? parts[1] : "";
  const pathTags = first.split(/[+\s]+/).map((t) => { try { return decodeURIComponent(t); } catch { return t; } });
  return discoverParamsFromQuery(u.searchParams, pathTags, parts[2]?.toLowerCase());
}

/** The same filters on bandcamp.com (Open on Bandcamp). */
export function discoverWebUrl(p: DiscoverParams): string {
  const c = DISCOVER_CATEGORIES.find((x) => x.id === p.category && x.id !== 0);
  const tags = p.tags.length ? `/${p.tags.map(encodeURIComponent).join("+")}` : c ? "/all" : "";
  const u = new URL(`https://bandcamp.com/discover${tags}${c ? `/${c.slug}` : ""}`);
  if (p.slice !== "top") u.searchParams.set("s", p.slice);
  const t = DISCOVER_TIMES.find((x) => x.id === p.time);
  if (t && t.id >= 0) u.searchParams.set("t", t.slug);
  if (p.location) u.searchParams.set("loc", String(p.location));
  return u.toString();
}
