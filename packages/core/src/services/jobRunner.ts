import type { Db } from "../db/Db.js";
import { now } from "../db/Db.js";
import * as jobs from "../db/repos/jobs.js";
import { albumUrlsInLibrary } from "../db/repos/albums.js";
import { unmarkRemoving } from "../db/repos/albumRemoval.js";
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
import { settleRelease } from "../db/repos/releases.js";
import { resolvePending } from "../db/repos/importPending.js";
import { getSetting, setSettingWhileJobRuns } from "../db/repos/settings.js";
import type { CookieStatus, Job, JobItem, SyncSummary } from "../types.js";
import { downloadItemTrack, downloadItemUrl, type DownloadBudget, type OfflineService } from "./offline.js";

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
  /** "library" for the albums of an imported library file. */
  kind?: "selection" | "library";
}

/**
 * Processes import jobs one at a time. Lives for the whole app session; on
 * construction it re-queues jobs that were running when the app last closed.
 */
export class JobRunner {
  private running = false;
  private forceFlags = new Map<number, boolean>();
  /** Collection syncs started by the background refresh (this session; a resumed one counts as manual). */
  private autoSyncs = new Set<number>();
  /** Per download job: the one forced album re-scrape its tracks may spend on CDN refusals. */
  private downloadBudgets = new Map<number, DownloadBudget>();
  private reset: Promise<void>;
  private resetFailed = false;
  private resetRetried = false;
  private ready: Promise<void>;

  constructor(private db: Db, private queue: FetchQueue, private onChange: () => void = () => {}, private offline: OfflineService | null = null) {
    // The stale-job reset settles "pending" jobs, so it must finish before any job is
    // created: every enqueue waits for it. Not for the first kick, which may run for minutes;
    // the "pending" status keeps a half-created job away from that kick instead.
    this.reset = this.runReset();
    this.ready = this.reset.then(() => this.kick());
  }

  private runReset(): Promise<void> {
    return jobs.resetStaleJobs(this.db).then(
      () => { this.resetFailed = false; },
      (e) => { this.resetFailed = true; console.error(`[jobs] resetting stale jobs: ${String(e)}`); },
    );
  }

  /**
   * Wait for the startup reset. If it failed, the first enqueue after that retries it once, so
   * a job left pending by a crash doesn't stay pending (and count as busy) all session.
   */
  private async afterReset(): Promise<void> {
    await this.reset;
    if (this.resetFailed && !this.resetRetried) {
      this.resetRetried = true;
      this.reset = this.runReset();
    }
    await this.reset;
  }

  /** Validate the URL, create a job and start processing in the background. */
  async enqueue(req: ImportRequest): Promise<Job> {
    const n = normalizeBandcampUrl(req.url);
    await this.afterReset();
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
    await this.afterReset();
    const job = await jobs.createJob(this.db, req.kind ?? "selection", req.label, urls);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /**
   * Sync the purchased collection and wishlist of the username in Settings, as one job.
   * Returns the sync already queued or running, if there is one. `auto` marks the background
   * refresh: the same sync, except that it doesn't re-send a cookie the last sync found
   * rejected (see syncLists).
   */
  async enqueueSync(opts: { auto?: boolean } = {}): Promise<Job> {
    const username = (await getSetting<{ username?: string }>(this.db, ACCOUNT_KEY))?.username;
    if (!username) throw new ScrapeError("no_account", "Add your Bandcamp username in Settings first");
    await this.afterReset();
    const active = await this.db.get<{ id: number }>("SELECT id FROM jobs WHERE kind = 'collection' AND status IN ('pending','queued','running') ORDER BY id LIMIT 1");
    if (active) return (await jobs.getJob(this.db, active.id))!;
    const job = await jobs.createJob(this.db, "collection", fanPageUrl(username), []);
    if (opts.auto) this.autoSyncs.add(job.id);
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /**
   * Save offline copies of an album's streamable tracks that don't have one yet (#2), as one
   * "download" job with an item per track, processed one track at a time like any import
   * (rate-limited queue, challenge cooldown, resumed after a restart, cancellable between
   * tracks). Returns the album's download already queued or running if there is one, or null
   * when every track is saved already. `trackIds` limits it to those library tracks.
   */
  async enqueueDownload(albumId: number, trackIds?: number[]): Promise<Job | null> {
    if (!this.offline?.available) throw new ScrapeError("offline_unavailable", "Offline copies aren't available here");
    const album = await this.db.get<{ url: string }>("SELECT url FROM albums WHERE id = ?", [albumId]);
    if (!album) throw new ScrapeError("not_found", `Album ${albumId} is not in the library`);
    await this.afterReset();
    const active = await this.db.get<{ id: number }>("SELECT id FROM jobs WHERE kind = 'download' AND input_url = ? AND status IN ('pending','queued','running') ORDER BY id LIMIT 1", [album.url]);
    if (active) return (await jobs.getJob(this.db, active.id))!;
    const only = trackIds ? new Set(trackIds) : null;
    const rows = (await this.db.select<{ id: number; track_id: number }>(
      "SELECT id, track_id FROM tracks WHERE album_id = ? AND streamable = 1 AND local_path IS NULL ORDER BY track_num, id", [albumId]))
      .filter((r) => !only || only.has(r.id));
    if (!rows.length) return null;
    const job = await jobs.createJob(this.db, "download", album.url, rows.map((r) => downloadItemUrl(album.url, r.track_id)));
    this.onChange();
    void this.kick();
    return (await jobs.getJob(this.db, job.id))!;
  }

  /** Cancel the queued or running download of one album (its URL), or every download. */
  async cancelDownloads(albumUrl?: string): Promise<void> {
    const changed = albumUrl
      ? (await this.db.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE kind = 'download' AND input_url = ? AND status IN ('pending','queued','running')", [now(), albumUrl])).changes > 0
      : await jobs.cancelJobsOfKind(this.db, "download");
    if (changed) this.onChange();
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
      let full: string | null = null;
      for (let item = await jobs.nextQueuedItem(this.db, job.id); item; item = await jobs.nextQueuedItem(this.db, job.id)) {
        if ((await jobs.jobStatus(this.db, job.id)) === "cancelled") return;
        try {
          if (job.kind === "download") {
            const albumId = await this.downloadItem(job.id, item);
            if (albumId === null) return;
            await jobs.setItemResult(this.db, item.id, job.id, true, albumId, null);
            this.onChange();
            continue;
          }
          // An earlier item of this sync may have brought it in (a track with its album).
          const have = job.kind === "collection" ? await fan.libraryAlbumForFetchUrl(this.db, item.url) : null;
          if (have !== null) {
            await jobs.setItemResult(this.db, item.id, job.id, true, have, null);
            await this.settle(item.url, have);
            await this.keep(have);
            await this.resolveImports(have);
            this.onChange();
            continue;
          }
          // A purchase goes out with the identity cookie (if set) so the page lists mp3-v0.
          const headers = (await fan.isCollectionFetchUrl(this.db, item.url)) ? await identityHeaders(this.db, item.url) : {};
          const html = await this.fetchForJob(job.id, item.url, headers.Cookie ? { headers } : undefined);
          if (html === null) return;
          const albumId = await upsertTralbum(this.db, parseTralbumPage(html));
          await jobs.setItemResult(this.db, item.id, job.id, true, albumId, null);
          // An imported release is no longer new (New releases), even if it's removed again later.
          await this.settle(item.url, albumId);
          await this.keep(albumId);
          // Playlist entries, plays and preferences from an imported library that waited for this album.
          await this.resolveImports(albumId);
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
          const fullDisk = e instanceof ScrapeError && e.code === "disk_error" && (e.detail as { full?: boolean } | undefined)?.full;
          if (e instanceof ScrapeError && (e.code === "storage_full" || e.code === "cdn_refused" || fullDisk)) {
            // The size limit, a full disk, or a CDN that refuses this album even after a fresh
            // page: the rest would stop the same way, so they fail now with that reason.
            full = `[${e.code}] ${e.message}`;
            await jobs.failQueuedItems(this.db, job.id, full);
            break;
          }
        }
        this.onChange();
      }
      await this.resolveImports();
      // Decide from the items, not from counters a crash could have left one short.
      await jobs.recountJob(this.db, job.id);
      const final = (await jobs.getJob(this.db, job.id, false))!;
      if (final.status === "cancelled") return;
      // Items that landed after the loop found none queued: back to the queue (the kick
      // loop picks the job up again) rather than finishing with work left undone.
      if (!challenged && !full && (await jobs.nextQueuedItem(this.db, job.id))) {
        await jobs.transitionJob(this.db, job.id, ["running"], "queued");
        return;
      }
      const allFailed = final.total > 0 && final.failed === final.total;
      // Keep the clear challenge message when that is why the job stopped.
      const why = challenged ? "[client_challenge] Bandcamp kept returning its bot check"
        : full ?? (allFailed ? (job.kind === "download" ? "Every track failed to download" : "Every item failed to import") : note);
      await jobs.transitionJob(this.db, job.id, ["running"], allFailed ? "failed" : "done", why);
    } catch (e) {
      if (e instanceof JobCancelled) return;
      const msg = e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
      console.error(`[job ${job.id}] ${msg}`);
      await jobs.transitionJob(this.db, job.id, ["running", "queued"], "failed", msg);
    } finally {
      this.forceFlags.delete(job.id);
      this.autoSyncs.delete(job.id);
      this.downloadBudgets.delete(job.id);
      this.onChange();
    }
  }

  /**
   * Mark an imported release as no longer new. Bookkeeping only: the import already
   * succeeded, so a failure here is logged and never turns the item into a failure.
   */
  private async settle(url: string, albumId: number): Promise<void> {
    try {
      await settleRelease(this.db, url, albumId);
    } catch (e) {
      console.error(`[jobs] settling new release ${url}: ${String(e)}`);
    }
  }

  /**
   * An album imported again while it waited for its delete (#93) stays: its removal mark goes,
   * so the delete that the Undo note would run skips it. Only imports do this; a stream
   * refresh (upsertTralbum too) never cancels a removal.
   */
  private async keep(albumId: number): Promise<void> {
    try {
      await unmarkRemoving(this.db, [albumId]);
    } catch (e) {
      console.error(`[jobs] keeping album ${albumId}: ${String(e)}`);
    }
  }

  /**
   * Resolve what an imported library left waiting: for one album after its item, everything
   * at the end of the job. Bookkeeping too: logged, never an item failure.
   */
  private async resolveImports(albumId?: number): Promise<void> {
    try {
      await resolvePending(this.db, albumId);
    } catch (e) {
      console.error(`[jobs] resolving imported library entries: ${String(e)}`);
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
   * One track of a download job (#2): its offline copy, with the same cooldown handling as
   * fetchForJob (the album page refresh and the mp3 both go through the queue). Returns the
   * track's album id, or null if the job was cancelled while paused.
   */
  private async downloadItem(jobId: number, item: JobItem): Promise<number | null> {
    const offline = this.offline;
    if (!offline?.available) throw new ScrapeError("offline_unavailable", "Offline copies aren't available here");
    const bcid = downloadItemTrack(item.url);
    const t = bcid == null ? null : await this.db.get<{ id: number; album_id: number }>("SELECT id, album_id FROM tracks WHERE track_id = ?", [bcid]);
    if (!t) throw new ScrapeError("not_found", "The track is no longer in the library");
    for (let challenges = 0; ;) {
      if (!(await this.waitOutCooldown(jobId))) return null;
      // Checked per track, so the limit stops a job part way (the last copy may pass it a little).
      if (await offline.capReached()) throw new ScrapeError("storage_full", "Offline copies reached the size limit in Settings");
      try {
        let budget = this.downloadBudgets.get(jobId);
        if (!budget) this.downloadBudgets.set(jobId, (budget = { rescrapes: 1 }));
        await offline.download(t.id, budget);
        return t.album_id;
      } catch (e) {
        if (!(e instanceof ScrapeError)) throw e;
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
    const prev = await getSetting<SyncSummary>(this.db, SYNC_KEY);
    // On a manual sync the fan page always gets a stored cookie, even one the last sync found
    // rejected, so a cookie that only looked signed-out once can come back on its own. The
    // background refresh doesn't keep offering Bandcamp a cookie it turned down: it reads the
    // public lists, and the cookie's status stays as the last sync left it.
    const auto = this.autoSyncs.has(job.id);
    const headers = await identityHeaders(this.db, pageUrl, { revalidate: !auto });
    const withheld = auto && !headers.Cookie && (prev?.cookie === "rejected" || prev?.cookie === "other_account");
    const page = parseFanPage(await fetch(pageUrl, { headers }));
    // Recognised as this fan: the cookie is used for the API too (private collections).
    const cookie: CookieStatus = withheld ? prev!.cookie : !headers.Cookie ? "none" : page.own_page ? "ok" : page.logged_in ? "other_account" : "rejected";
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
    if (!(await jobs.transitionJob(this.db, id, ["pending", "queued", "running"], "cancelled"))) return false;
    this.onChange();
    return true;
  }
}
