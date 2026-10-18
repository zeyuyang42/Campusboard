import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { normalizeBandcampUrl } from "../scrape/url.js";
import { parseMusicPage } from "../scrape/parseMusic.js";
import { ScrapeError } from "../scrape/errors.js";
import { cachedFetchText } from "./pageCache.js";
import { albumUrlsInLibrary } from "../db/repos/albums.js";
import { getSetting, setSetting } from "../db/repos/settings.js";
import * as releases from "../db/repos/releases.js";
import {
  PAGE_CACHE_MS, RELEASE_CHECK_INTERVAL_MS, RELEASE_CHECK_SETTING_KEY, RELEASE_CHECK_START_DELAY_MS, RELEASE_CHECK_TICK_MS,
} from "../config.js";
import type { ArtistCheckResult, ReleaseCheckStatus } from "../types.js";

export interface ReleaseCheckerOptions {
  onChange?: () => void;
  intervalMs?: number;
  startDelayMs?: number;
  tickMs?: number;
}

/** Why a tick did nothing. */
export type SkipReason = "off" | "cooldown" | "job" | "busy" | "none_due";

/** Album/track URL in canonical form, or null for anything normalizeBandcampUrl refuses. */
function releaseUrl(u: string): string | null {
  try {
    const n = normalizeBandcampUrl(u);
    return n.kind === "artist" ? null : n.url;
  } catch {
    return null;
  }
}

/**
 * Finds releases that library artists published after their first check.
 *
 * While the app is open a timer ticks every `tickMs`, starting `startDelayMs` after start().
 * Each tick checks at most one artist (the most overdue one, never more often than once per
 * `intervalMs`) with at most one request: the /music page through FetchQueue (serial,
 * 1 req/s, challenge gate) and the page cache, with no retries. A tick does nothing while the
 * setting is off, a challenge cooldown runs, an import or sync job is queued or running, or
 * another check is in progress.
 *
 * An artist's first successful check is the baseline: everything listed then is stored as
 * seen, so only releases that show up on a later check count as new.
 */
export class ReleaseChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private busy = false;
  private sweeping = false;
  private readonly intervalMs: number;
  private readonly startDelayMs: number;
  private readonly tickMs: number;

  constructor(private db: Db, private queue: FetchQueue, private opts: ReleaseCheckerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? RELEASE_CHECK_INTERVAL_MS;
    this.startDelayMs = opts.startDelayMs ?? RELEASE_CHECK_START_DELAY_MS;
    this.tickMs = opts.tickMs ?? RELEASE_CHECK_TICK_MS;
  }

  /** Begin background checks; the first tick comes after the start delay, never at launch. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setTimeout(() => void this.loop(), this.startDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    this.timer = null;
    try {
      await this.tick();
    } catch (e) {
      console.error("[releases] tick failed", e);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.tickMs);
    }
  }

  async enabled(): Promise<boolean> {
    return (await getSetting<{ enabled?: boolean }>(this.db, RELEASE_CHECK_SETTING_KEY))?.enabled !== false;
  }

  async setEnabled(on: boolean): Promise<void> {
    await setSetting(this.db, RELEASE_CHECK_SETTING_KEY, { enabled: on });
    this.opts.onChange?.();
  }

  /**
   * Why a check may not run right now (setting off, cooldown, a job), or null when it may.
   * The busy flag is claimed separately and synchronously, see claim().
   */
  async blocked(): Promise<Exclude<SkipReason, "none_due" | "busy"> | null> {
    if (!(await this.enabled())) return "off";
    await this.queue.gate.ready();
    if (this.queue.gate.until()) return "cooldown";
    if (await this.db.get("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1")) return "job";
    return null;
  }

  /**
   * Take the busy flag, synchronously and before any await, so a tick, Check now and a
   * single-artist check can never run at the same time. False if it is already taken.
   */
  private claim(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  /** One background step: check the most overdue artist, if any is due and nothing blocks. */
  async tick(now = Date.now()): Promise<ArtistCheckResult | { skipped: SkipReason }> {
    if (!this.claim()) return { skipped: "busy" };
    try {
      const why = await this.blocked();
      if (why) return { skipped: why };
      const artist = await releases.nextDueArtist(this.db, now, this.intervalMs);
      if (!artist) return { skipped: "none_due" };
      return await this.check(artist);
    } finally {
      this.busy = false;
    }
  }

  /**
   * "Check now": every unmuted library artist in turn, regardless of when it was last
   * checked. Still one request per artist through the 1 req/s queue and the page cache,
   * and it stops as soon as the setting goes off, a cooldown starts or a job is queued.
   */
  async checkNow(): Promise<{ checked: number; found: number; stopped: SkipReason | null }> {
    if (!this.claim()) return { checked: 0, found: 0, stopped: "busy" };
    this.sweeping = true;
    this.opts.onChange?.();
    try {
      let checked = 0, found = 0;
      const artists = await releases.watchedArtists(this.db);
      for (const artist of artists) {
        // Re-checked before every artist: a job or cooldown may start during the sweep.
        const why = await this.blocked();
        if (why) return { checked, found, stopped: why };
        const r = await this.check(artist);
        checked++;
        found += r.found;
        this.opts.onChange?.();
      }
      if (!artists.length) {
        const why = await this.blocked();
        if (why) return { checked, found, stopped: why };
      }
      return { checked, found, stopped: null };
    } finally {
      this.busy = false;
      this.sweeping = false;
      this.opts.onChange?.();
    }
  }

  /** Check one artist now (the selftest's single request). Respects the busy flag; the queue enforces the cooldown. */
  async checkArtist(artistId: number): Promise<ArtistCheckResult> {
    const skipped = (error: string): ArtistCheckResult => ({ artist_id: artistId, status: "skipped", releases: 0, inserted_ids: [], found: 0, error });
    if (!this.claim()) return skipped("busy");
    try {
      const artist = await this.db.get<releases.WatchedArtist>("SELECT id, url, name FROM artists WHERE id = ?", [artistId]);
      if (!artist) return skipped("no such artist");
      return await this.check(artist);
    } finally {
      this.busy = false;
    }
  }

  async status(): Promise<ReleaseCheckStatus> {
    const s = await releases.watchSummary(this.db);
    return { enabled: await this.enabled(), ...s, running: this.sweeping };
  }

  /**
   * Fetch and record one artist's /music page. Writes go releases first, then the watch row,
   * so an interruption at worst repeats the check (inserts are ON CONFLICT DO NOTHING).
   */
  private async check(artist: releases.WatchedArtist): Promise<ArtistCheckResult> {
    const base: ArtistCheckResult = { artist_id: artist.id, status: "failed", releases: 0, inserted_ids: [], found: 0 };
    const at = Date.now();
    let musicUrl: string;
    try {
      const n = normalizeBandcampUrl(artist.url);
      if (n.kind !== "artist") throw new ScrapeError("invalid_url", `Not an artist URL: ${artist.url}`);
      musicUrl = n.url;
    } catch (e) {
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      await releases.markChecked(this.db, artist.id, at, false, msg);
      return { ...base, error: msg };
    }
    try {
      // retries = 0: a background check is never more than one request.
      const html = await cachedFetchText(this.db, this.queue, musicUrl, PAGE_CACHE_MS, 0);
      const parsed = parseMusicPage(html, new URL(musicUrl).origin);
      const watch = await releases.getWatch(this.db, artist.id);
      const baseline = !watch?.baselined;
      const have = await albumUrlsInLibrary(this.db);
      // Matched on the path under this artist, not the full URL: when an artist adds, changes
      // or drops a custom domain every URL on the page changes host, and that must neither
      // re-list the back catalogue as new nor miss what the library already holds.
      const known = await releases.knownPaths(this.db, artist.id);
      const inLibrary = await releases.libraryPaths(this.db, artist.id);
      const onPage = new Set<string>();
      const fresh: releases.ReleaseRow[] = [];
      for (const it of parsed.items) {
        // Links come from page markup a custom domain controls: anything that fails the
        // pasted-URL check (LAN hosts, odd paths) is dropped, never stored or shown.
        const url = releaseUrl(it.url);
        if (!url) continue;
        const path = releases.releasePath(url);
        if (onPage.has(path)) continue;
        onPage.add(path);
        if (known.has(path)) continue;
        fresh.push({
          url, item_type: /\/track\//.test(url) ? "track" : "album", title: it.title, art_id: it.art_id ?? null,
          artist_override: it.artist ?? null, status: baseline || have.has(url) || inLibrary.has(path) ? "seen" : "new",
        });
      }
      const inserted = await releases.insertReleases(this.db, artist.id, fresh);
      await releases.settleImported(this.db);
      await releases.markChecked(this.db, artist.id, at, true, null);
      return {
        ...base, status: baseline ? "baseline" : "checked", releases: onPage.size,
        inserted_ids: inserted.map((r) => r.id), found: inserted.filter((r) => r.status === "new").length,
      };
    } catch (e) {
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      // A challenge leaves the artist due: the cooldown already keeps every tick quiet, and
      // the check should happen once Bandcamp lets us back in. Anything else (404, a page
      // that doesn't parse, offline) counts as today's check so it isn't retried every tick.
      if (!(e instanceof ScrapeError && (e.code === "client_challenge" || e.code === "challenge_cooldown"))) {
        await releases.markChecked(this.db, artist.id, at, false, msg);
      }
      return { ...base, error: msg };
    } finally {
      this.opts.onChange?.();
    }
  }
}
