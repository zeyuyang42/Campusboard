import { DOWNLOAD_IDLE_MS, FETCH_TIMEOUT_MS, RATE_LIMIT_MS, USER_AGENT } from "../config.js";
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
/** `FetchQueue.fetchText` or anything standing in for it (a job's cooldown-aware fetch). */
export type TextFetcher = (url: string, init: RequestInit) => Promise<string>;

/** The parsed JSON of an API answer; `parse_failed` when it isn't JSON (`what` names the API). */
export function jsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ScrapeError("parse_failed", `${what} response was not JSON`);
  }
}

/** POST a JSON body to one of Bandcamp's APIs and parse the JSON answer. */
export async function postJson(fetchText: TextFetcher, url: string, body: unknown, what: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const text = await fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  return jsonText(text, what);
}

export class FetchQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  constructor(private fetchImpl: FetchLike, private minGapMs = RATE_LIMIT_MS, readonly gate = new ChallengeGate()) {}

  /**
   * Run `fn` in turn, at most one start per minGapMs. Refuses (without waiting, and before
   * taking a place in the chain) during a challenge cooldown, once the gate's persisted state
   * is loaded.
   */
  private async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.gate.ready();
    this.gate.assertClear();
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

  /**
   * The one request shape: the caller's init plus `extra`, this signal, and plain headers
   * (UA, Accept-Language, then the caller's), on purpose: the bot check reacts to header
   * sets that look inconsistent.
   */
  private request(url: string, init: RequestInit, signal: AbortSignal, extra: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      ...extra,
      signal,
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
    });
  }

  async fetchText(url: string, init: RequestInit = {}, retries = 2): Promise<string> {
    return this.schedule(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await this.request(url, init, ctrl.signal);
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
   * runner downloads one track at a time). No retries.
   *
   * The timeout is an idle one, started once the queue slot is ours: the download fails when
   * no data arrives for DOWNLOAD_IDLE_MS, however long the whole file takes. `signal` stops it
   * (Remove download while a track is in flight). Errors: HTTP errors carry `{ status }`; no
   * answer, a stalled or cut-off body carries `{ network: true }`; a stop carries
   * `{ aborted: true }`; a failure writing the file is `disk_error`.
   * Resolves to the bytes written and the Content-Length (null when the CDN sent none).
   */
  async download(url: string, sink: (body: ReadableStream<Uint8Array>) => Promise<void>, init: RequestInit = {}): Promise<{ bytes: number; expected: number | null }> {
    const outer = init.signal;
    if (outer?.aborted) throw stopped(url);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onAbort);
    let idle: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; ctrl.abort(); }, DOWNLOAD_IDLE_MS);
    };
    try {
      const res = await this.schedule(async () => {
        if (outer?.aborted) throw stopped(url);
        touch();
        try {
          return await this.request(url, init, ctrl.signal);
        } catch (e) {
          if (outer?.aborted) throw stopped(url);
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
      // Read the body ourselves, so a failure reading it (network) can be told apart from a
      // failure writing it (disk), and every chunk restarts the idle timer.
      let bytes = 0;
      let readFailed = false;
      const reader = res.body.getReader();
      const counted = new ReadableStream<Uint8Array>({
        async pull(c) {
          let r: ReadableStreamReadResult<Uint8Array>;
          try { r = await reader.read(); } catch (e) { readFailed = true; c.error(e); return; }
          if (r.done) { c.close(); return; }
          touch();
          bytes += r.value.byteLength;
          c.enqueue(r.value);
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      try {
        await sink(counted);
      } catch (e) {
        if (outer?.aborted) throw stopped(url);
        if (readFailed || stalled || ctrl.signal.aborted) {
          throw new ScrapeError("fetch_failed", `Download of ${url} stopped: ${stalled ? "no data for a while" : String(e)}`, { network: true });
        }
        if (e instanceof ScrapeError) throw e;
        void reader.cancel().catch(() => undefined);
        const full = /ENOSPC|no space|disk full/i.test(String(e));
        throw new ScrapeError("disk_error", full ? `The disk is full (${String(e)})` : `Couldn't save the file: ${String(e)}`, { full });
      }
      if (outer?.aborted) throw stopped(url);
      const length = Number(res.headers.get("content-length"));
      const expected = Number.isFinite(length) && length > 0 ? length : null;
      if (stalled || (expected != null && bytes !== expected)) {
        throw new ScrapeError("fetch_failed", `Download of ${url} was cut short (${bytes} of ${expected ?? "?"} bytes)`, { network: true });
      }
      return { bytes, expected };
    } finally {
      clearTimeout(idle);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Request `url` without following a redirect and return the absolute Location of its 3xx
   * answer (a radio episode's stream_redirect, #44). The body is never read: it is cancelled.
   * Same queue slot, headers and challenge handling as fetchText; no retries.
   */
  async resolveRedirect(url: string, init: RequestInit = {}): Promise<string> {
    return this.schedule(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await this.request(url, init, ctrl.signal, { redirect: "manual" });
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

/** The error for a download stopped through its signal (Remove download, #2). */
function stopped(url: string): ScrapeError {
  return new ScrapeError("fetch_failed", `Download of ${url} was stopped`, { aborted: true });
}
