import type { Db } from "../db/Db.js";
import type { ChallengeGate } from "../scrape/challenge.js";
import type { JobRunner } from "./jobRunner.js";
import { getSetting, setSetting } from "../db/repos/settings.js";
import { ACCOUNT_KEY, SYNC_KEY } from "./account.js";
import { idleBlock } from "./idle.js";
import {
  COLLECTION_REFRESH_INTERVAL_MS, COLLECTION_REFRESH_LAST_KEY, COLLECTION_REFRESH_SETTING_KEY, COLLECTION_REFRESH_START_DELAY_MS, COLLECTION_REFRESH_TICK_MS,
} from "../config.js";
import type { CollectionRefreshStatus, SyncSummary } from "../types.js";

export interface CollectionRefreshOptions {
  onChange?: () => void;
  intervalMs?: number;
  startDelayMs?: number;
  tickMs?: number;
}

/** Why a tick did not start a sync. */
export type RefreshSkip = "off" | "no_account" | "cooldown" | "job" | "not_due" | "busy";

/**
 * Keeps Purchased and Wishlist current without pressing Sync now.
 *
 * While the app is open a timer ticks every `tickMs`, starting `startDelayMs` after start()
 * (never at launch). A tick starts the collection sync job when the setting is on, an account
 * is set, no challenge cooldown runs, no job is pending, queued or running, and neither an
 * automatic refresh nor any sync (manual ones count) happened in the last `intervalMs`.
 *
 * The sync is the manual one (JobRunner.enqueueSync), with its rules: one serial job through
 * FetchQueue, the cookie only to bandcamp.com, nothing removed unless both lists were read in
 * full with the access the account last had. The one difference: a cookie the last sync found
 * rejected isn't sent again (the public lists are still read); Sync now keeps retrying it.
 *
 * The attempt time is stored before the job is created, so a refresh that fails is not retried
 * until the next interval, and a crash can't turn into a burst at the next launch.
 */
export class CollectionRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private busy = false;
  private readonly intervalMs: number;
  private readonly startDelayMs: number;
  private readonly tickMs: number;

  constructor(private db: Db, private gate: ChallengeGate, private runner: JobRunner, private opts: CollectionRefreshOptions = {}) {
    this.intervalMs = opts.intervalMs ?? COLLECTION_REFRESH_INTERVAL_MS;
    this.startDelayMs = opts.startDelayMs ?? COLLECTION_REFRESH_START_DELAY_MS;
    this.tickMs = opts.tickMs ?? COLLECTION_REFRESH_TICK_MS;
  }

  /** Begin background refreshes; the first look comes after the start delay. */
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
      console.error("[collection refresh] tick failed", e);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.tickMs);
    }
  }

  // The toggle and the last-run time are separate rows, each written by one side only, so a
  // tick can't turn the toggle back on and a toggle can't drop the last-run time.
  private async enabled(): Promise<boolean> {
    return (await getSetting<{ enabled?: boolean }>(this.db, COLLECTION_REFRESH_SETTING_KEY))?.enabled !== false;
  }

  private async lastAuto(): Promise<number | null> {
    const v = await getSetting<number>(this.db, COLLECTION_REFRESH_LAST_KEY);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  async setEnabled(on: boolean): Promise<void> {
    await setSetting(this.db, COLLECTION_REFRESH_SETTING_KEY, { enabled: on });
    this.opts.onChange?.();
  }

  async status(): Promise<CollectionRefreshStatus> {
    return { enabled: await this.enabled(), last_auto_at: await this.lastAuto() };
  }

  /** One look: start the sync if it is due and nothing stands in the way. */
  async tick(now = Date.now()): Promise<{ job_id: number } | { skipped: RefreshSkip }> {
    // Claimed before any await, so two ticks can never both pass the checks below.
    if (this.busy) return { skipped: "busy" };
    this.busy = true;
    try {
      if (!(await this.enabled())) return { skipped: "off" };
      if (!(await getSetting<{ username?: string }>(this.db, ACCOUNT_KEY))?.username) return { skipped: "no_account" };
      const why = await idleBlock(this.db, this.gate);
      if (why) return { skipped: why };
      const lastSync = Date.parse((await getSetting<SyncSummary>(this.db, SYNC_KEY))?.at ?? "");
      // A time in the future means the clock moved back: ignore it rather than wait for it.
      const last = Math.max(...[(await this.lastAuto()) ?? 0, Number.isFinite(lastSync) ? lastSync : 0].filter((t) => t <= now), 0);
      if (now - last < this.intervalMs) return { skipped: "not_due" };
      await setSetting(this.db, COLLECTION_REFRESH_LAST_KEY, now);
      const job = await this.runner.enqueueSync({ auto: true });
      this.opts.onChange?.();
      return { job_id: job.id };
    } finally {
      this.busy = false;
    }
  }
}
