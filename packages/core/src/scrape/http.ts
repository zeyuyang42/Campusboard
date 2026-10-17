import { FETCH_TIMEOUT_MS, RATE_LIMIT_MS, USER_AGENT } from "../config.js";
import { ScrapeError } from "./errors.js";

/**
 * Serial, rate-limited fetch queue. Every Bandcamp request goes through here so we
 * never exceed ~1 request/second regardless of how many callers there are.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FetchQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  constructor(private fetchImpl: FetchLike, private minGapMs = RATE_LIMIT_MS) {}

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastStart + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async fetchText(url: string, init: RequestInit = {}, retries = 2): Promise<string> {
    return this.schedule(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await this.fetchImpl(url, {
            ...init,
            signal: ctrl.signal,
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
          });
          if (res.status === 404) throw new ScrapeError("not_found", `404 for ${url}`);
          if (res.status === 429 || res.status >= 500) {
            lastErr = new ScrapeError("fetch_failed", `HTTP ${res.status} for ${url}`);
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          if (!res.ok) throw new ScrapeError("fetch_failed", `HTTP ${res.status} for ${url}`);
          return await res.text();
        } catch (e) {
          if (e instanceof ScrapeError && e.code !== "fetch_failed") throw e;
          // The http plugin (scopeRedirects on) or the dev proxy refused the URL or a redirect
          // hop: the page led somewhere that isn't Bandcamp. Retrying can't help.
          const denied = String(e).match(/url not allowed on the configured scope: (\S+)/);
          if (denied) throw new ScrapeError("not_bandcamp", `${url} redirected outside Bandcamp (${denied[1]})`);
          lastErr = e;
          if (attempt === retries) break;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      if (lastErr instanceof ScrapeError) throw lastErr;
      throw new ScrapeError("fetch_failed", `Failed to fetch ${url}: ${String(lastErr)}`);
    });
  }
}

