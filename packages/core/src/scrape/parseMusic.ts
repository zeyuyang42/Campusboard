import { ScrapeError } from "./errors.js";
import { readJsonAttr, pageTitle, decodeEntities, stripTags, hasBandcampMarker } from "./html.js";
import { normalizeBandcampUrl } from "./url.js";
import { BandSchema } from "./schemas.js";
import { isChallengePage } from "./parseTralbum.js";
import type { ItemType } from "../types.js";
import { z } from "zod";

export interface MusicItem {
  url: string; // absolute, no query
  item_type: ItemType;
  title: string;
  art_id: number | null;
  /** Set on label pages where each release has its own artist. */
  artist: string | null;
}

export interface ParsedMusicPage {
  /** Canonical artist origin (the custom domain if the artist has one), from the page's data-tralbum url. */
  origin: string;
  band: { band_id: number; name: string } | null;
  items: MusicItem[]; // page order, deduped by url
}

const ClientItem = z.object({ page_url: z.string(), title: z.string().optional(), art_id: z.number().nullable().optional(), artist: z.string().nullable().optional(), type: z.string().optional() }).passthrough();

/**
 * Absolute, normalized album/track URL, or null. Links come from page markup a
 * custom domain controls, so every one goes through the same check as pasted
 * URLs (no LAN hosts, Bandcamp-shaped paths only) before anything can fetch it.
 */
function cleanUrl(u: string, base: string): string | null {
  const abs = /^https?:\/\//i.test(u) ? u : `${base}${u.startsWith("/") ? "" : "/"}${u}`;
  try {
    const n = normalizeBandcampUrl(abs);
    return n.kind === "artist" ? null : n.url;
  } catch {
    return null;
  }
}
const typeOf = (url: string): ItemType => (/\/track\//.test(url) ? "track" : "album");
const artIdFrom = (s: string): number | null => {
  const m = s.match(/\/img\/a0*(\d+)_\d+\.(?:jpg|png)/);
  return m ? Number(m[1]) : null;
};

export function parseMusicPage(html: string, origin: string): ParsedMusicPage {
  if (isChallengePage(html)) throw new ScrapeError("client_challenge", "Bandcamp returned a bot challenge page");
  if (!hasBandcampMarker(html)) throw new ScrapeError("not_bandcamp", `Not a Bandcamp page (title: ${pageTitle(html) ?? "?"})`);
  const base = canonicalOrigin(html) ?? origin.replace(/\/+$/, "");
  const seen = new Map<string, MusicItem>();
  const push = (it: MusicItem) => {
    const prev = seen.get(it.url);
    if (!prev) seen.set(it.url, it);
    else seen.set(it.url, { ...prev, title: prev.title || it.title, art_id: prev.art_id ?? it.art_id, artist: prev.artist ?? it.artist });
  };

  const grid = html.match(/<ol[^>]*id="music-grid"[^>]*>([\s\S]*?)<\/ol>/);
  const region = grid ? grid[1] : html;
  for (const li of region.matchAll(/<li[^>]*class="[^"]*music-grid-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
    const block = li[1];
    const href = block.match(/href="((?:https?:\/\/[^/"]+)?\/(?:album|track)\/[^"]+)"/)?.[1];
    const url = href ? cleanUrl(href, base) : null;
    if (!url) continue;
    const img = block.match(/<img[^>]*(?:data-original|src)="([^"]+)"/)?.[1] ?? "";
    const titleBlock = block.match(/<p class="title">([\s\S]*?)<\/p>/)?.[1] ?? "";
    const artist = titleBlock.match(/<span class="artist-override">([\s\S]*?)<\/span>/)?.[1];
    const title = stripTags(titleBlock.replace(/<span class="artist-override">[\s\S]*?<\/span>/, ""));
    push({ url, item_type: typeOf(url), title, art_id: artIdFrom(img), artist: artist ? stripTags(artist) : null });
  }
  if (!grid) {
    // No grid: fall back to bare links anywhere on the page.
    for (const m of html.matchAll(/href="((?:https?:\/\/[^/"]+)?\/(?:album|track)\/[^"]+)"/g)) {
      const url = cleanUrl(m[1], base);
      if (url && !seen.has(url)) push({ url, item_type: typeOf(url), title: "", art_id: null, artist: null });
    }
  }

  try {
    const extra = readJsonAttr<unknown[]>(html, "data-client-items");
    if (Array.isArray(extra)) {
      for (const raw of extra) {
        const p = ClientItem.safeParse(raw);
        if (!p.success) continue;
        const url = cleanUrl(p.data.page_url, base);
        if (!url) continue;
        push({ url, item_type: p.data.type === "track" ? "track" : typeOf(url), title: decodeEntities(p.data.title ?? ""), art_id: p.data.art_id ?? null, artist: p.data.artist ?? null });
      }
    }
  } catch { /* tolerate */ }

  let band: ParsedMusicPage["band"] = null;
  try {
    const b = BandSchema.safeParse(readJsonAttr(html, "data-band"));
    if (b.success) band = { band_id: b.data.id, name: b.data.name };
  } catch { /* tolerate */ }

  const items = [...seen.values()].map((it) => ({ ...it, title: it.title || it.url.split("/").pop()!.replace(/-/g, " ") }));
  if (items.length === 0 && !band) {
    throw new ScrapeError("parse_failed", `No discography items found (title: ${pageTitle(html) ?? "?"})`);
  }
  return { origin: base, band, items };
}

/**
 * Artist pages embed `data-tralbum="{"url":"https://<canonical>/music"}"`. For an
 * artist with a custom domain that is the custom domain even when the page was
 * served from name.bandcamp.com, so relative release links resolve to the same
 * URLs that album pages report and the library stores.
 */
function canonicalOrigin(html: string): string | null {
  try {
    const t = readJsonAttr<{ url?: unknown }>(html, "data-tralbum");
    if (typeof t?.url !== "string") return null;
    return new URL(normalizeBandcampUrl(t.url).url).origin;
  } catch {
    return null;
  }
}
