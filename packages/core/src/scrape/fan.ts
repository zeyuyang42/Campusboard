import { z } from "zod";
import { ScrapeError } from "./errors.js";
import { decodeEntities, isChallengePage, pageTitle } from "./html.js";
import { isBandcampHost, normalizeBandcampUrl } from "./url.js";
import type { ItemType } from "../types.js";

/**
 * A fan's purchases ("collection") and wishlist. The public fan page at
 * bandcamp.com/<username> embeds the first batch of each list in
 * `#pagedata[data-blob]`; the rest come from POST /api/fancollection/1/<list>_items.
 * Both work without a cookie for public profiles (verified 2026-10-17).
 */
export type FanList = "collection" | "wishlist";

export interface FanItem {
  item_type: ItemType;
  bandcamp_id: number;
  /** Canonical URL as Bandcamp lists it; may be an artist's custom domain. */
  url: string;
  /** The same page on name.bandcamp.com (see fanItemFetchUrl). */
  fetch_url: string;
  title: string | null;
  artist: string | null;
  /** Paging token of this item, when the response carries one. */
  token: string | null;
}

export interface FanListPage {
  items: FanItem[];
  /** Items Bandcamp says the list holds (page only). */
  count: number | null;
  /** Entries Bandcamp sent in this batch, including ones dropped as not albums or tracks. */
  received: number;
  more: boolean;
  /** Pass as older_than_token to get the next batch. */
  next: string | null;
}

export interface ParsedFanPage {
  fan_id: number;
  username: string;
  collection: FanListPage;
  wishlist: FanListPage;
  /** A Bandcamp account was recognised from the request's cookie. */
  logged_in: boolean;
  /** The recognised account is the one whose page this is. */
  own_page: boolean;
}

/** Bandcamp usernames seen in the wild: letters, digits, "_" and "-". */
const USERNAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Accept "name", "bandcamp.com/name" or "https://bandcamp.com/name[/wishlist]"; return the username. */
export function normalizeFanUsername(input: string): string {
  const t = input.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?bandcamp\.com\//i, "").replace(/[/?#].*$/, "");
  if (!USERNAME.test(t)) throw new ScrapeError("invalid_username", `Not a Bandcamp username: ${input}`);
  return t;
}

export const fanPageUrl = (username: string) => `https://bandcamp.com/${normalizeFanUsername(username)}`;
export const FAN_ITEMS_ENDPOINT: Record<FanList, string> = {
  collection: "https://bandcamp.com/api/fancollection/1/collection_items",
  wishlist: "https://bandcamp.com/api/fancollection/1/wishlist_items",
};

const UrlHintsSchema = z.object({ subdomain: z.string().nullable().optional() }).passthrough();
export const FanItemSchema = z
  .object({
    tralbum_type: z.string(),
    tralbum_id: z.number(),
    item_url: z.string().nullable().optional(),
    item_title: z.string().nullable().optional(),
    band_name: z.string().nullable().optional(),
    token: z.string().nullable().optional(),
    url_hints: UrlHintsSchema.nullable().optional(),
  })
  .passthrough();

const ListDataSchema = z
  .object({
    item_count: z.number().nullable().optional(),
    last_token: z.string().nullable().optional(),
    sequence: z.array(z.string()).nullable().optional(),
    pending_sequence: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const FanBlobSchema = z
  .object({
    fan_data: z.object({ fan_id: z.number(), username: z.string(), is_own_page: z.unknown().optional() }).passthrough(),
    identities: z.object({ fan: z.unknown().optional() }).passthrough().nullable().optional(),
    collection_data: ListDataSchema.nullable().optional(),
    wishlist_data: ListDataSchema.nullable().optional(),
    item_cache: z.record(z.record(z.unknown()).nullable()).nullable().optional(),
  })
  .passthrough();

export const FanItemsResponseSchema = z
  .object({
    items: z.array(z.unknown()),
    more_available: z.boolean().nullable().optional(),
    last_token: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * The name.bandcamp.com address of an item. Albums on a custom domain are served
 * under the subdomain too (200, no redirect; verified 2026-10-17), and that is the
 * only kind of host the identity cookie may go to. `url_hints.slug` is not used: on
 * track items it can name the track's album.
 */
export function fanItemFetchUrl(itemUrl: string, subdomain: string | null | undefined): string | null {
  let n;
  try { n = normalizeBandcampUrl(itemUrl); } catch { return null; }
  if (n.kind === "artist") return null;
  if (!n.custom) return n.url;
  if (!subdomain || !/^[a-z0-9-]{1,63}$/i.test(subdomain)) return null;
  const sub = `https://${subdomain.toLowerCase()}.bandcamp.com${new URL(n.url).pathname}`;
  try { return normalizeBandcampUrl(sub).url; } catch { return null; }
}

/** One list entry as Bandcamp sends it, or null for anything that isn't an album or track. */
export function toFanItem(raw: unknown): FanItem | null {
  const r = FanItemSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const item_type: ItemType | null = d.tralbum_type === "a" ? "album" : d.tralbum_type === "t" ? "track" : null;
  if (!item_type || !d.item_url) return null;
  let url: string;
  try {
    const n = normalizeBandcampUrl(d.item_url);
    if (n.kind !== item_type) return null;
    url = n.url;
  } catch {
    return null;
  }
  const fetch_url = fanItemFetchUrl(url, d.url_hints?.subdomain);
  if (!fetch_url) return null;
  return { item_type, bandcamp_id: d.tralbum_id, url, fetch_url, title: d.item_title ?? null, artist: d.band_name ?? null, token: d.token ?? null };
}

function readBlob(html: string): unknown {
  const m = html.match(/<div[^>]*\bid="pagedata"[^>]*\bdata-blob="([^"]*)"/) ?? html.match(/\bdata-blob="([^"]*)"[^>]*\bid="pagedata"/);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch (e) {
    throw new ScrapeError("parse_failed", "Fan page data-blob is not valid JSON", String(e));
  }
}

export function parseFanPage(html: string): ParsedFanPage {
  if (isChallengePage(html)) throw new ScrapeError("client_challenge", "Bandcamp returned a bot challenge page");
  const raw = readBlob(html);
  const res = FanBlobSchema.safeParse(raw);
  if (!raw || !res.success) {
    throw new ScrapeError("parse_failed", `Not a Bandcamp fan page (title: ${pageTitle(html) ?? "?"})`, res.success ? undefined : res.error.issues[0]);
  }
  const b = res.data;
  const list = (key: FanList): FanListPage => {
    const data = key === "collection" ? b.collection_data : b.wishlist_data;
    const cache = (b.item_cache?.[key] ?? {}) as Record<string, unknown>;
    // The first batch is listed in `sequence`, or `pending_sequence` for lists not on the open tab.
    const seq = data?.sequence?.length ? data.sequence : (data?.pending_sequence ?? []);
    const items = seq.map((k) => toFanItem(cache[k])).filter((i): i is FanItem => !!i);
    const count = data?.item_count ?? null;
    const next = data?.last_token ?? null;
    return { items, count, received: seq.length, more: !!next && count !== null && count > seq.length, next };
  };
  const fan = b.identities?.fan;
  return {
    fan_id: b.fan_data.fan_id,
    username: b.fan_data.username,
    collection: list("collection"),
    wishlist: list("wishlist"),
    logged_in: !!fan,
    own_page: !!fan && !!b.fan_data.is_own_page,
  };
}

export function parseFanItemsResponse(text: string): FanListPage {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ScrapeError("parse_failed", "Fan collection response was not JSON"); }
  if (json && typeof json === "object" && (json as { error?: unknown }).error) {
    throw new ScrapeError("fetch_failed", `Bandcamp refused the collection request: ${String((json as { error_message?: unknown }).error_message ?? "error")}`);
  }
  const res = FanItemsResponseSchema.safeParse(json);
  if (!res.success) throw new ScrapeError("parse_failed", `Fan collection schema mismatch: ${res.error.issues[0]?.path.join(".")}`);
  const items = res.data.items.map(toFanItem).filter((i): i is FanItem => !!i);
  // With count > 20, last_token is the 20th item's token, not the last one's (verified
  // 2026-10-17), so page on from the last item's own token.
  const lastRaw = res.data.items[res.data.items.length - 1] as { token?: unknown } | undefined;
  const next = (typeof lastRaw?.token === "string" ? lastRaw.token : null) ?? res.data.last_token ?? null;
  return { items, count: null, received: res.data.items.length, more: !!res.data.more_available && res.data.items.length > 0 && !!next, next };
}

/** Items per API request; Bandcamp honours up to at least 100 (the site asks for 20). */
export const FAN_PAGE_SIZE = 100;
/** Stop paging after this many API requests per list, whatever Bandcamp says. */
export const FAN_MAX_PAGES = 200;

export interface FanListResult {
  items: FanItem[];
  /** Every page was read, so items absent here really left the list. */
  complete: boolean;
}

/**
 * Read a whole list: the page's first batch, then API pages. `fetchText` must go through
 * the FetchQueue (so the 1 req/s limit and the challenge gate apply). Deduplicates by item, stops when
 * Bandcamp says there is no more, a page adds nothing new, or FAN_MAX_PAGES is reached.
 */
export async function fetchFanList(
  fetchText: (url: string, init: RequestInit) => Promise<string>, fanId: number, list: FanList, first: FanListPage, headers: Record<string, string> = {},
): Promise<FanListResult> {
  const seen = new Map<string, FanItem>();
  const add = (items: FanItem[]) => {
    let added = 0;
    for (const i of items) {
      const k = `${i.item_type}:${i.bandcamp_id}`;
      if (!seen.has(k)) { seen.set(k, i); added++; }
    }
    return added;
  };
  add(first.items);
  let { more, next } = first;
  let received = first.received;
  for (let pages = 0; more && next; pages++) {
    if (pages >= FAN_MAX_PAGES) return { items: [...seen.values()], complete: false };
    const text = await fetchText(FAN_ITEMS_ENDPOINT[list], {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify({ fan_id: fanId, older_than_token: next, count: FAN_PAGE_SIZE }),
    });
    const page = parseFanItemsResponse(text);
    if (add(page.items) === 0 && page.items.length > 0) return { items: [...seen.values()], complete: false };
    received += page.received;
    ({ more, next } = page);
  }
  // Fewer entries than the page announced (a private list seen without a working cookie,
  // or a batch Bandcamp didn't page): don't let this read clear anything.
  return { items: [...seen.values()], complete: first.count === null || received >= first.count };
}

/** True for hosts the identity cookie may be sent to: https bandcamp.com and its subdomains. */
export function mayCarryIdentity(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && isBandcampHost(u.hostname);
  } catch {
    return false;
  }
}
