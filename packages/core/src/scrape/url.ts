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
/** Suffixes that name machines on a local or private network, never a public artist site. */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp"];

/**
 * Whether a parsed URL may be fetched as a custom Bandcamp domain: a public DNS
 * name over http(s), no port, credentials, IP literal, bare hostname or private suffix.
 */
export function isPublicCustomHost(u: URL): boolean {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port || u.username || u.password) return false;
  if (!host.includes(".") || IPV4.test(host) || host.startsWith("[") || host === "localhost") return false;
  return !PRIVATE_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1));
}

/**
 * Whether a URL is one the app may fetch for Bandcamp pages: anything on
 * bandcamp.com/bcbits.com, or a Bandcamp-shaped path (/album/x, /track/x,
 * /music) on a public custom host. Mirrors the Tauri http scope.
 */
export function isFetchableBandcampUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (isBandcampHost(host) || host === "bcbits.com" || host.endsWith(".bcbits.com")) return true;
  return isPublicCustomHost(u) && /^\/(album\/[^/]+|track\/[^/]+|music)\/?$/.test(u.pathname);
}

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
  if (custom && !isPublicCustomHost(u)) {
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
