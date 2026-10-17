import type { Db } from "../db/Db.js";
import * as jobs from "../db/repos/jobs.js";
import { albumUrlsInLibrary } from "../db/repos/albums.js";
import type { FetchQueue } from "../scrape/http.js";
import { normalizeBandcampUrl } from "../scrape/url.js";
import { parseMusicPage } from "../scrape/parseMusic.js";
import { parseTralbumPage } from "../scrape/parseTralbum.js";
import { ScrapeError } from "../scrape/errors.js";
import { upsertTralbum } from "./importService.js";
import { cachedFetchText } from "./pageCache.js";
import { ACCOUNT_KEY, SYNC_KEY, identityHeaders } from "./account.js";
import { fetchFanList, normalizeFanUsername, parseFanPage, fanPageUrl, type FanList, type FanListResult } from "../scrape/fan.js";
import * as fan from "../db/repos/fanItems.js";
import { getSetting, setSettingWhileJobRuns } from "../db/repos/settings.js";
import type { CookieStatus, Job, SyncSummary } from "../types.js";

/** Thrown inside a job when it was cancelled while waiting; process() swallows it. */
class JobCancelled extends Error {}

interface JobFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const COOKIE_NOTES: Partial<Record<CookieStatus, string>> = {
  rejected: "Bandcamp didn't accept the identity cookie (it may have expired), so only the public collection was synced. Paste a fresh one in Settings.",
  other_account: "The identity cookie belongs to a different Bandcamp account than this username, so it wasn't used.",
};

function safeReleaseUrl(u: string): string | null {
  try {
    const n = normalizeBandcampUrl(u);
    return n.kind === "artist" ? null : n.url;
  } catch {
    return null;
  }
}

export interface ImportRequest {
  url: string;
  force?: boolean; // re-import discography items that are already in the library
}

export interface ImportSelectionRequest {
  /** Album/track URLs chosen on a browse page. */
  urls: string[];
  /** Shown as the job's source, e.g. the artist page URL. */
  label: string;
}

/**
 * Processes import jobs one at a time. Lives for the whole app session; on
 * construction it re-queues jobs that were running when the app last closed.
 */
export class JobRunner {
  private running = false;
  private forceFlags = new Map<number, boolean>();
  private ready: Promise<void>;

  constructor(private db: Db, private queue: FetchQueue, private onChange: () => void = () => {}) {
    this.ready = jobs.resetStaleJobs(db).then(() => this.kick());
  }

  /** Validate the URL, create a job and start processing in the background. */
  async enqueue(req: ImportRequest): Promise<Job> {
    const n = normalizeBandcampUrl(req.url);
    const job = n.kind === "artist"
      ? await jobs.createJob(this.db, "discography", n.url, [])
      : await jobs.createJob(this.db, n.kind, n.url, [n.url]);
    this.forceFlags.set(job.id, !!req.force);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /** Import a hand-picked set of album/track URLs as one job. */
  async enqueueSelection(req: ImportSelectionRequest): Promise<Job> {
    const urls = [...new Set(req.urls.map((u) => normalizeBandcampUrl(u)).filter((n) => n.kind !== "artist").map((n) => n.url))];
    if (!urls.length) throw new ScrapeError("invalid_url", "Nothing selected to import");
    const job = await jobs.createJob(this.db, "selection", req.label, urls);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /**
   * Sync the purchased collection and wishlist of the username in Settings, as one job.
   * Returns the sync already queued or running, if there is one.
   */
  async enqueueSync(): Promise<Job> {
    const username = (await getSetting<{ username?: string }>(this.db, ACCOUNT_KEY))?.username;
    if (!username) throw new ScrapeError("no_account", "Add your Bandcamp username in Settings first");
    const active = await this.db.get<{ id: number }>("SELECT id FROM jobs WHERE kind = 'collection' AND status IN ('queued','running') ORDER BY id LIMIT 1");
    if (active) return (await jobs.getJob(this.db, active.id))!;
    const job = await jobs.createJob(this.db, "collection", fanPageUrl(username), []);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  whenReady(): Promise<void> { return this.ready; }

  async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = await jobs.nextQueuedJob(this.db); job; job = await jobs.nextQueuedJob(this.db)) {
        await this.process(job);
      }
    } finally {
      this.running = false;
      this.onChange();
    }
  }

  private async process(job: Job): Promise<void> {
    let note: string | null = null;
    try {
      // Conditional, so a cancel that landed after nextQueuedJob() read the row wins.
      // Inside the try so the finally below always clears this job's force flag.
      if (!(await jobs.transitionJob(this.db, job.id, ["queued"], "running"))) return;
      this.onChange();
      if (job.kind === "collection" && job.total === 0) {
        const synced = await this.syncLists(job);
        note = synced.note;
        if (synced.queued === 0) {
          await jobs.transitionJob(this.db, job.id, ["running"], "done", note ?? "Everything in your collection and wishlist is already in your library");
          return;
        }
      } else if (job.kind === "collection") {
        // Resumed after a restart: the lists were synced already, only imports remain.
        note = COOKIE_NOTES[(await getSetting<SyncSummary>(this.db, SYNC_KEY))?.cookie ?? "none"] ?? null;
      }
      if (job.kind === "discography" && job.total === 0) {
        const origin = new URL(job.input_url).origin;
        const html = await this.fetchForJob(job.id, job.input_url);
        if (html === null) return;
        const parsed = parseMusicPage(html, origin);
        const have = await albumUrlsInLibrary(this.db);
        const force = this.forceFlags.get(job.id) ?? false;
        // Release links come from page markup: queue only URLs that pass the same check as pasted ones.
        const urls = [...new Set(parsed.items.map((i) => safeReleaseUrl(i.url)).filter((u): u is string => !!u))].filter((u) => force || !have.has(u));
        await jobs.addJobItems(this.db, job.id, urls);
        if (urls.length === 0) {
          await jobs.transitionJob(this.db, job.id, ["running"], "done", parsed.items.length ? "Everything from this artist is already in your library" : "No releases found on this page");
          return;
        }
      }
      let challenged = false;
      for (let item = await jobs.nextQueuedItem(this.db, job.id); item; item = await jobs.nextQueuedItem(this.db, job.id)) {
        if ((await jobs.jobStatus(this.db, job.id)) === "cancelled") return;
        try {
          // An earlier item of this sync may have brought it in (a track with its album).
          const have = job.kind === "collection" ? await fan.libraryAlbumForFetchUrl(this.db, item.url) : null;
          if (have !== null) {
            await jobs.setItemResult(this.db, item.id, job.id, true, have, null);
            this.onChange();
            continue;
          }
          // A purchase goes out with the identity cookie (if set) so the page lists mp3-v0.
          const headers = (await fan.isCollectionFetchUrl(this.db, item.url)) ? await identityHeaders(this.db, item.url) : {};
          const html = await this.fetchForJob(job.id, item.url, headers.Cookie ? { headers } : undefined);
          if (html === null) return;
          const albumId = await upsertTralbum(this.db, parseTralbumPage(html));
          await jobs.setItemResult(this.db, item.id, job.id, true, albumId, null);
        } catch (e) {
          const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
          console.error(`[job ${job.id}] ${item.url}: ${msg}`);
          await jobs.setItemResult(this.db, item.id, job.id, false, null, msg);
          if (e instanceof ScrapeError && e.code === "client_challenge") {
            // The retry after a full cooldown was challenged too: the block isn't lifting.
            // Stop probing rather than spend two challenged requests per remaining release;
            // the rest fail with the same reason and can be imported again later.
            challenged = true;
            await jobs.failQueuedItems(this.db, job.id, `[client_challenge] Skipped: Bandcamp kept returning its bot check`);
            break;
          }
        }
        this.onChange();
      }
      const final = (await jobs.getJob(this.db, job.id, false))!;
      if (final.status === "cancelled") return;
      const allFailed = final.total > 0 && final.done === 0;
      // Keep the clear challenge message when that is why the job stopped.
      const why = challenged ? "[client_challenge] Bandcamp kept returning its bot check" : allFailed ? "Every item failed to import" : note;
      await jobs.transitionJob(this.db, job.id, ["running"], allFailed ? "failed" : "done", why);
    } catch (e) {
      if (e instanceof JobCancelled) return;
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      console.error(`[job ${job.id}] ${msg}`);
      await jobs.transitionJob(this.db, job.id, ["running", "queued"], "failed", msg);
    } finally {
      this.forceFlags.delete(job.id);
      this.onChange();
    }
  }

  /**
   * Fetch for a job, honouring the challenge cooldown. While a cooldown runs the job goes
   * back to "queued" and its items stay queued; a challenge on this fetch waits out the
   * new cooldown and retries once. Returns null if the job was cancelled while paused.
   */
  private async fetchForJob(jobId: number, url: string, init?: JobFetchInit): Promise<string | null> {
    for (let challenges = 0; ;) {
      if (!(await this.waitOutCooldown(jobId))) return null;
      try {
        // Plain page GETs share the page cache. Sync requests and anything sent with the
        // identity cookie don't: those answers are per account and must be fresh.
        return init ? await this.queue.fetchText(url, init) : await cachedFetchText(this.db, this.queue, url);
      } catch (e) {
        if (!(e instanceof ScrapeError)) throw e;
        // Another request tripped the gate while this one waited in the queue: not an attempt.
        if (e.code === "challenge_cooldown") continue;
        if (e.code === "client_challenge" && challenges++ === 0) continue;
        throw e;
      }
    }
  }

  /**
   * Wait for any challenge cooldown to end. False if the job was cancelled meanwhile; the
   * wait checks for that every CHALLENGE_POLL_MS so a cancel frees the runner promptly.
   */
  private async waitOutCooldown(jobId: number): Promise<boolean> {
    const gate = this.queue.gate;
    await gate.ready();
    const cancelled = async () => (await jobs.jobStatus(this.db, jobId)) === "cancelled";
    if (!gate.until()) return !(await cancelled());
    // Single conditional statements, so a cancel between steps is never overwritten.
    if (!(await jobs.transitionJob(this.db, jobId, ["running"], "queued"))) return false;
    this.onChange();
    await gate.waitClear(cancelled);
    const resumed = await jobs.transitionJob(this.db, jobId, ["queued"], "running");
    this.onChange();
    return resumed;
  }

  /**
   * Phase one of a collection sync: read the fan page and every page of both lists, then
   * record membership and flags, then queue imports for what the library lacks. Nothing is
   * written until both lists are read, and then in an order where any interruption leaves
   * a readable library: memberships upserted, departed ones removed (only for lists read in
   * full), owned flags recomputed, job items added, summary saved. Each step is idempotent,
   * so a restart simply runs this phase again.
   */
  private async syncLists(job: Job): Promise<{ queued: number; note: string | null }> {
    const username = normalizeFanUsername(new URL(job.input_url).pathname.slice(1));
    const stillThisAccount = async () => {
      const current = (await getSetting<{ username?: string }>(this.db, ACCOUNT_KEY))?.username;
      if (!current || current.toLowerCase() !== username.toLowerCase()) {
        throw new ScrapeError("no_account", "The Bandcamp account in Settings changed during the sync");
      }
    };
    await stillThisAccount();
    const fetch = async (url: string, init: JobFetchInit) => {
      const r = await this.fetchForJob(job.id, url, init);
      if (r === null) throw new JobCancelled();
      return r;
    };
    const pageUrl = fanPageUrl(username);
    // The fan page always gets a stored cookie, even one the last sync found rejected,
    // so a cookie that only looked signed-out once can come back on its own.
    const headers = await identityHeaders(this.db, pageUrl, { revalidate: true });
    const page = parseFanPage(await fetch(pageUrl, { headers }));
    const prev = await getSetting<SyncSummary>(this.db, SYNC_KEY);
    // Recognised as this fan: the cookie is used for the API too (private collections).
    const cookie: CookieStatus = !headers.Cookie ? "none" : page.own_page ? "ok" : page.logged_in ? "other_account" : "rejected";
    const apiHeaders = cookie === "ok" ? headers : {};
    // Once a sync saw the lists signed in, a signed-out read may show less (a private
    // collection looks empty), so only another signed-in read may remove items.
    const everAuthenticated = !!prev?.authenticated || prev?.cookie === "ok";
    const mayRemove = cookie === "ok" || !everAuthenticated;

    const apiFetch = (u: string, i: RequestInit) => fetch(u, { method: i.method, headers: i.headers as Record<string, string>, body: i.body as string });
    const lists: Record<FanList, FanListResult> = {
      collection: await fetchFanList(apiFetch, page.fan_id, "collection", page.collection, apiHeaders),
      wishlist: await fetchFanList(apiFetch, page.fan_id, "wishlist", page.wishlist, apiHeaders),
    };
    const stillRunning = async () => {
      if ((await jobs.jobStatus(this.db, job.id)) !== "running") throw new JobCancelled();
      await stillThisAccount();
    };
    await stillRunning();

    // Each write below is conditional on the job still running (removing or changing the
    // account cancels it first), so a removal that lands in between can't be undone.
    for (const list of ["collection", "wishlist"] as const) await fan.upsertFanItems(this.db, list, lists[list].items, job.id);
    const removed = { collection: mayRemove && lists.collection.complete, wishlist: mayRemove && lists.wishlist.complete };
    for (const list of ["collection", "wishlist"] as const) if (removed[list]) await fan.removeUnseen(this.db, list, job.id);
    await fan.recomputeOwned(this.db);
    await stillRunning();
    // Item URLs come from Bandcamp's JSON: queue only ones that pass the same check as pasted links.
    const urls = [...new Set((await fan.missingFetchUrls(this.db)).map(safeReleaseUrl).filter((u): u is string => !!u))];
    if (urls.length) await jobs.addJobItems(this.db, job.id, urls);
    const counts = await fan.countFanItems(this.db);
    const summary: SyncSummary = {
      at: new Date().toISOString(), username: page.username, collection: counts.collection, wishlist: counts.wishlist,
      queued: urls.length, complete: removed.collection && removed.wishlist, cookie,
      authenticated: everAuthenticated || cookie === "ok", job_id: job.id,
    };
    if (!(await setSettingWhileJobRuns(this.db, SYNC_KEY, summary, job.id))) throw new JobCancelled();
    this.onChange();
    return { queued: urls.length, note: COOKIE_NOTES[cookie] ?? null };
  }

  async cancel(id: number): Promise<boolean> {
    if (!(await jobs.transitionJob(this.db, id, ["queued", "running"], "cancelled"))) return false;
    this.onChange();
    return true;
  }
}
