import { ScrapeError } from "./errors.js";

export type UrlKind = "album" | "track" | "artist";
export interface NormalizedUrl {
  kind: UrlKind;
  url: string; // canonical https URL, no query/hash/trailing slash
  host: string;
}

/** Normalize a user-pasted Bandcamp URL into a canonical form and classify it. */
export function normalizeBandcampUrl(input: string): NormalizedUrl {
  let u: URL;
  try {
    const trimmed = input.trim();
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ScrapeError("invalid_url", `Not a valid URL: ${input}`);
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".bandcamp.com") || host === "www.bandcamp.com" || host === "bandcamp.com") {
    throw new ScrapeError("not_bandcamp", `Expected an artist subdomain like name.bandcamp.com, got ${host}`);
  }
  const pathname = u.pathname.replace(/\/+$/, "");
  const origin = `https://${host}`;
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/album\/([^/]+)$/))) return { kind: "album", url: `${origin}/album/${m[1]}`, host };
  if ((m = pathname.match(/^\/track\/([^/]+)$/))) return { kind: "track", url: `${origin}/track/${m[1]}`, host };
  if (pathname === "" || pathname === "/music" || pathname === "/releases") {
    return { kind: "artist", url: `${origin}/music`, host };
  }
  throw new ScrapeError("invalid_url", `Unsupported Bandcamp path: ${pathname}`);
}
