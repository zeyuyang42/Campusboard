import { ScrapeError } from "./errors.js";
import { readJsonAttr, pageTitle } from "./html.js";
import { BandSchema, ClientItemSchema } from "./schemas.js";
import { isChallengePage } from "./parseTralbum.js";

export interface ParsedMusicPage {
  band: { band_id: number; name: string } | null;
  items: string[]; // absolute album/track URLs in page order
}

export function parseMusicPage(html: string, origin: string): ParsedMusicPage {
  if (isChallengePage(html)) throw new ScrapeError("client_challenge", "Bandcamp returned a bot challenge page");
  const base = origin.replace(/\/+$/, "");
  const seen = new Set<string>();
  const items: string[] = [];
  const push = (u: string) => {
    const abs = u.startsWith("http") ? u : `${base}${u}`;
    const clean = abs.split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (!/\/(album|track)\/[^/]+$/.test(clean)) return;
    if (!seen.has(clean)) {
      seen.add(clean);
      items.push(clean);
    }
  };

  const grid = html.match(/<ol[^>]*id="music-grid"[^>]*>([\s\S]*?)<\/ol>/);
  const region = grid ? grid[1] : html;
  for (const m of region.matchAll(/href="((?:https?:\/\/[^/"]+)?\/(?:album|track)\/[^"]+)"/g)) push(m[1]);

  try {
    const extra = readJsonAttr<unknown[]>(html, "data-client-items");
    if (Array.isArray(extra)) {
      for (const it of extra) {
        const p = ClientItemSchema.safeParse(it);
        if (p.success) push(p.data.page_url);
      }
    }
  } catch {
    /* tolerate */
  }

  let band: ParsedMusicPage["band"] = null;
  try {
    const b = BandSchema.safeParse(readJsonAttr(html, "data-band"));
    if (b.success) band = { band_id: b.data.id, name: b.data.name };
  } catch {
    /* tolerate */
  }

  if (items.length === 0 && !band) {
    throw new ScrapeError("parse_failed", `No discography items found (title: ${pageTitle(html) ?? "?"})`);
  }
  return { band, items };
}
