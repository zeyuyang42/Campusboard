import { ScrapeError } from "./errors.js";
import { decodeEntities, readJsonAttr, pageTitle } from "./html.js";
import { TralbumSchema, LdJsonSchema } from "./schemas.js";
import type { ItemType } from "@bc/shared";

export interface ParsedTrack {
  track_id: number;
  title: string;
  track_num: number | null;
  duration: number | null;
  artist: string | null;
  streamable: boolean;
  stream_url: string | null;
  stream_expires_at: number | null; // unix ms
  lyrics: string | null;
}

export interface ParsedTralbum {
  item_type: ItemType;
  bandcamp_id: number;
  artist: { band_id: number; name: string; url: string };
  title: string;
  url: string;
  art_id: number | null;
  release_date: string | null;
  about: string | null;
  credits: string | null;
  tags: string[];
  is_preorder: boolean;
  parent_album_id: number | null; // for /track pages: the album's bandcamp id, if any
  tracks: ParsedTrack[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Derive expiry from the `ts=` query param on a bcbits stream URL. */
export function streamExpiry(streamUrl: string, fetchedAt: number): number {
  const m = streamUrl.match(/[?&]ts=(\d+)/);
  if (m) return Number(m[1]) * 1000;
  return fetchedAt + DAY_MS;
}

export function isChallengePage(html: string): boolean {
  const t = pageTitle(html);
  return !!t && /client challenge/i.test(t);
}

export function parseTralbumPage(html: string, fetchedAt = Date.now()): ParsedTralbum {
  if (isChallengePage(html)) throw new ScrapeError("client_challenge", "Bandcamp returned a bot challenge page");
  let raw: unknown;
  try {
    raw = readJsonAttr(html, "data-tralbum");
  } catch (e) {
    throw new ScrapeError("parse_failed", "data-tralbum is not valid JSON", String(e));
  }
  if (!raw) {
    throw new ScrapeError("parse_failed", `No data-tralbum attribute found (title: ${pageTitle(html) ?? "?"})`);
  }
  const res = TralbumSchema.safeParse(raw);
  if (!res.success) {
    throw new ScrapeError("parse_failed", `data-tralbum schema mismatch: ${res.error.issues[0]?.path.join(".")} ${res.error.issues[0]?.message}`, res.error.issues);
  }
  const t = res.data;

  let tags: string[] = [];
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const parsed = LdJsonSchema.safeParse(JSON.parse(ld[1]));
      if (parsed.success && parsed.data.keywords) tags = parsed.data.keywords;
    } catch {
      /* tolerate */
    }
  }

  const pageUrl = new URL(t.url);
  const artistUrl = `${pageUrl.protocol}//${pageUrl.host}`;

  const tracks: ParsedTrack[] = t.trackinfo.map((ti) => {
    const stream = ti.file?.["mp3-128"] ?? null;
    const streamable = !!stream && (ti.streaming ?? 1) !== 0;
    return {
      track_id: ti.track_id,
      title: decodeEntities(ti.title),
      track_num: ti.track_num ?? null,
      duration: ti.duration ?? null,
      artist: ti.artist ?? null,
      streamable,
      stream_url: streamable ? stream : null,
      stream_expires_at: streamable && stream ? streamExpiry(stream, fetchedAt) : null,
      lyrics: ti.lyrics ?? null,
    };
  });

  return {
    item_type: t.item_type,
    bandcamp_id: t.id,
    artist: { band_id: t.current.band_id, name: t.artist, url: artistUrl },
    title: t.current.title,
    url: t.url,
    art_id: t.art_id ?? null,
    release_date: t.album_release_date ?? t.current.release_date ?? null,
    about: t.current.about ?? null,
    credits: t.current.credits ?? null,
    tags,
    is_preorder: !!t.is_preorder,
    parent_album_id: t.item_type === "track" ? (t.current.album_id ?? null) : null,
    tracks,
  };
}
