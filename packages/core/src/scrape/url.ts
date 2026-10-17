import { ScrapeError } from "./errors.js";

export type UrlKind = "album" | "track" | "artist";
export interface NormalizedUrl {
  kind: UrlKind;
  url: string; // canonical https URL, no query/hash/trailing slash
  host: string;
  /**
   * True when the host is not under bandcamp.com (an artist's custom domain).
   * Nothing about the host proves it is Bandcamp, so callers must confirm the
   * fetched page with `assertBandcampPage` before trusting it.
   */
  custom: boolean;
}

/** Hosts that are Bandcamp by name: bandcamp.com itself and every subdomain. */
export function isBandcampHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "bandcamp.com" || h.endsWith(".bandcamp.com");
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Normalize a user-pasted Bandcamp URL into a canonical form and classify it.
 *
 * Accepts artist subdomains (name.bandcamp.com) and, since some artists serve
 * their Bandcamp site from their own domain, any other public https host whose
 * path is Bandcamp-shaped: /album/<slug>, /track/<slug>, /music, /releases or
 * the root. The shape check is all that can be done offline; the page itself
 * proves it is Bandcamp once fetched.
 */
export function normalizeBandcampUrl(input: string): NormalizedUrl {
  let u: URL;
  try {
    const trimmed = input.trim();
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ScrapeError("invalid_url", `Not a valid URL: ${input}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ScrapeError("invalid_url", `Not a web URL: ${input}`);
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const custom = !isBandcampHost(host);
  if (host === "www.bandcamp.com" || host === "bandcamp.com") {
    throw new ScrapeError("not_bandcamp", `Expected an artist page like name.bandcamp.com, got ${host}`);
  }
  // Custom domains must look like a public domain name: no ports, credentials,
  // bare hostnames or IP literals, so a pasted link can't point the app at the LAN.
  if (custom && (u.port || u.username || u.password || !host.includes(".") || IPV4.test(host) || host.startsWith("[") || host.endsWith(".local") || host === "localhost" || host.endsWith(".localhost"))) {
    throw new ScrapeError("not_bandcamp", `${host} doesn't look like a Bandcamp site`);
  }
  const pathname = u.pathname.replace(/\/+$/, "");
  const origin = `https://${host}`;
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/album\/([^/]+)$/))) return { kind: "album", url: `${origin}/album/${m[1]}`, host, custom };
  if ((m = pathname.match(/^\/track\/([^/]+)$/))) return { kind: "track", url: `${origin}/track/${m[1]}`, host, custom };
  if (pathname === "" || pathname === "/music" || pathname === "/releases") {
    return { kind: "artist", url: `${origin}/music`, host, custom };
  }
  if (custom) throw new ScrapeError("not_bandcamp", `${host}${pathname} doesn't look like a Bandcamp album, track or artist page`);
  throw new ScrapeError("invalid_url", `Unsupported Bandcamp path: ${pathname}`);
}
