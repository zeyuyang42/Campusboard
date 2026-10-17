const NAMED: Record<string, string> = { amp: "&", quot: '"', lt: "<", gt: ">", apos: "'", nbsp: " " };

/** Decode HTML entities found in attribute values (named, decimal and hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1].toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}

/** Extract and JSON-parse an HTML attribute whose value is an escaped JSON blob. */
export function readJsonAttr<T = unknown>(html: string, attr: string): T | null {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`));
  if (!m) return null;
  return JSON.parse(decodeEntities(m[1])) as T;
}

export function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Whether the HTML is a Bandcamp-rendered page. Every album, track and artist
 * page carries a `data-tralbum` or `data-band` JSON attribute; a custom domain
 * that isn't (or is no longer) Bandcamp has neither.
 */
export function hasBandcampMarker(html: string): boolean {
  return /\sdata-(?:tralbum|band)="/.test(html);
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
