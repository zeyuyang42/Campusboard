import { DOWNLOAD_TIMEOUT_MS, FETCH_TIMEOUT_MS, RATE_LIMIT_MS, USER_AGENT } from "../config.js";
import { ScrapeError } from "./errors.js";
import { ChallengeGate } from "./challenge.js";
import { isChallengePage } from "./html.js";

/**
 * Serial, rate-limited fetch queue. Every Bandcamp request goes through here so we
 * never exceed ~1 request/second regardless of how many callers there are.
 *
 * When a response is Bandcamp's "Client Challenge" page the queue trips its
 * ChallengeGate and throws `client_challenge`. While the gate's cooldown runs, every
 * request fails fast with `challenge_cooldown` instead of going out. Retrying after
 * the cooldown is the caller's call (the job runner does, once).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FetchQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  constructor(private fetchImpl: FetchLike, private minGapMs = RATE_LIMIT_MS, readonly gate = new ChallengeGate()) {}

  /** Run `fn` in turn, at most one start per minGapMs. Refuses (without waiting) during a challenge cooldown. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      // A request queued behind one that got challenged fails here, before taking a rate-limit slot.
      this.gate.assertClear();
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
    await this.gate.ready();
    this.gate.assertClear();
    return this.schedule(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          // Plain headers on purpose: the bot check reacts to header sets that look inconsistent.
          const res = await this.fetchImpl(url, {
            ...init,
            signal: ctrl.signal,
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            if (isChallengePage(body)) throw await this.challenged(url);
          }
          if (res.status === 404) throw new ScrapeError("not_found", `404 for ${url}`);
          if (res.status === 429 || res.status >= 500) {
            lastErr = new ScrapeError("fetch_failed", `HTTP ${res.status} for ${url}`);
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          if (!res.ok) throw new ScrapeError("fetch_failed", `HTTP ${res.status} for ${url}`);
          const text = await res.text();
          if (isChallengePage(text)) throw await this.challenged(url);
          return text;
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
      // No answer at all (offline, DNS, timeout): the player treats this as "offline" (#2).
      throw new ScrapeError("fetch_failed", `Failed to fetch ${url}: ${String(lastErr)}`, { network: true });
    });
  }

  /**
   * Download `url` (an offline copy's mp3, #2) and hand its body to `sink` as a stream, so
   * the file is written as it arrives rather than buffered. Only the request's start takes a
   * queue slot, like every other request; the body then streams outside the queue (the job
   * runner downloads one track at a time). No retries. Resolves to the bytes `sink` consumed,
   * which must match Content-Length when the CDN sends one. HTTP errors carry `{ status }`.
   */
  async download(url: string, sink: (body: ReadableStream<Uint8Array>) => Promise<void>, init: RequestInit = {}): Promise<number> {
    await this.gate.ready();
    this.gate.assertClear();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await this.schedule(async () => {
        try {
          return await this.fetchImpl(url, {
            ...init,
            signal: ctrl.signal,
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
          });
        } catch (e) {
          throw new ScrapeError("fetch_failed", `Failed to fetch ${url}: ${String(e)}`, { network: true });
        }
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || /text\/html/i.test(type)) {
        const body = await res.text().catch(() => "");
        if (isChallengePage(body)) throw await this.challenged(url);
        throw new ScrapeError("fetch_failed", `HTTP ${res.status}${res.ok ? " (a page, not audio)" : ""} for ${url}`, { status: res.status });
      }
      if (!res.body) throw new ScrapeError("fetch_failed", `Empty answer for ${url}`, { status: res.status });
      let bytes = 0;
      const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) { bytes += chunk.byteLength; c.enqueue(chunk); },
      }));
      try {
        await sink(counted);
      } catch (e) {
        if (e instanceof ScrapeError) throw e;
        throw new ScrapeError("fetch_failed", `Download of ${url} stopped: ${String(e)}`, { network: true });
      }
      const expected = Number(res.headers.get("content-length"));
      if (ctrl.signal.aborted || (expected > 0 && bytes !== expected)) {
        throw new ScrapeError("fetch_failed", `Download of ${url} was cut short (${bytes} of ${expected || "?"} bytes)`, { network: true });
      }
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Request `url` without following a redirect and return the absolute Location of its 3xx
   * answer (a radio episode's stream_redirect, #44). The body is never read: it is cancelled.
   * Same queue slot, headers and challenge handling as fetchText; no retries.
   */
  async resolveRedirect(url: string, init: RequestInit = {}): Promise<string> {
    await this.gate.ready();
    this.gate.assertClear();
    return this.schedule(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            ...init,
            redirect: "manual",
            signal: ctrl.signal,
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
          });
        } catch (e) {
          throw new ScrapeError("fetch_failed", `Failed to fetch ${url}: ${String(e)}`);
        }
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          void res.body?.cancel().catch(() => undefined);
          try { return new URL(location, url).toString(); } catch { throw new ScrapeError("fetch_failed", `Bad redirect from ${url}`); }
        }
        const body = await res.text().catch(() => "");
        if (isChallengePage(body)) throw await this.challenged(url);
        if (res.status === 404) throw new ScrapeError("not_found", `404 for ${url}`);
        throw new ScrapeError("fetch_failed", `HTTP ${res.status} (no redirect) for ${url}`);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Start (or extend) the cooldown and build the error for this request. */
  private async challenged(url: string): Promise<ScrapeError> {
    const until = await this.gate.trip();
    return new ScrapeError("client_challenge", `Bandcamp returned a bot challenge page for ${url}`, { until });
  }
}
