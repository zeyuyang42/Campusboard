import { CHALLENGE_BACKOFF_MS, CHALLENGE_MAX_MS, CHALLENGE_POLL_MS, CHALLENGE_RESET_MS } from "../config.js";
import { ScrapeError } from "./errors.js";

/** A cooldown after Bandcamp served its bot check: no requests until `until`. */
export interface ChallengeState {
  until: number;
  /** Length of the current cooldown; the next challenge soon after doubles it. */
  cooldownMs: number;
}

export interface ChallengeStore {
  load(): Promise<ChallengeState | null>;
  save(state: ChallengeState): Promise<void>;
}

/**
 * A persisted state is only trusted if it is one this code could have written: a cooldown
 * no longer than the cap, ending no later than the cap from now. Anything else (a clock
 * that was wrong when it tripped, a corrupt or hand-edited row) is dropped, never honoured.
 */
const plausible = (s: unknown, now: number): s is ChallengeState => {
  if (!s || typeof s !== "object") return false;
  const { until, cooldownMs } = s as ChallengeState;
  return Number.isFinite(until) && Number.isFinite(cooldownMs) && cooldownMs > 0 &&
    cooldownMs <= CHALLENGE_MAX_MS && until <= now + CHALLENGE_MAX_MS;
};

/** "14:05" in local time, rounded up so a retry at that minute is never still on hold. */
export const clockTime = (ms: number) => new Date(Math.ceil(ms / 60_000) * 60_000).toTimeString().slice(0, 5);

/**
 * Shared state for Bandcamp's "Client Challenge" page. FetchQueue trips it when a
 * response is the challenge and refuses requests while it is active; the job runner
 * waits it out. Persisted through the store so a restart doesn't start knocking again.
 */
export class ChallengeGate {
  private state: ChallengeState | null = null;
  private loaded: Promise<void>;

  constructor(private store?: ChallengeStore, private onChange: () => void = () => {}) {
    this.loaded = store
      ? store.load().then((s) => { if (plausible(s, Date.now())) this.state = s; }, () => {})
      : Promise.resolve();
  }

  /** Resolves once the persisted state has been read. */
  ready(): Promise<void> { return this.loaded; }

  /** When the cooldown ends (ms timestamp), or null when requests may go out. */
  until(now = Date.now()): number | null {
    // The clock moved back since the trip: never hold for longer than the cap from now.
    if (this.state && this.state.until > now + CHALLENGE_MAX_MS) this.state = { until: now + CHALLENGE_MAX_MS, cooldownMs: CHALLENGE_MAX_MS };
    return this.state && this.state.until > now ? this.state.until : null;
  }

  /**
   * Record a challenge. The first one after a quiet spell pauses for CHALLENGE_BACKOFF_MS;
   * one during or shortly after a cooldown doubles it, capped at CHALLENGE_MAX_MS.
   */
  async trip(now = Date.now()): Promise<number> {
    await this.loaded;
    const prev = this.state;
    const cooldownMs = prev && now < prev.until + CHALLENGE_RESET_MS
      ? Math.min(prev.cooldownMs * 2, CHALLENGE_MAX_MS)
      : CHALLENGE_BACKOFF_MS;
    this.state = { until: now + cooldownMs, cooldownMs };
    // Best effort: losing the persisted copy only matters across a restart.
    await this.store?.save(this.state).catch(() => {});
    this.onChange();
    return this.state.until;
  }

  /** Throw the friendly cooldown error if requests are on hold. */
  assertClear(): void {
    const until = this.until();
    if (until) throw new ScrapeError("challenge_cooldown", `Bandcamp asked us to slow down. Try again after ${clockTime(until)}.`, { until });
  }

  /**
   * Sleep until the cooldown, including any extension made meanwhile, is over. Sleeps in
   * steps of at most CHALLENGE_POLL_MS (so no timer delay can overflow) and stops early
   * when `stop` says so, e.g. because the job waiting here was cancelled.
   */
  async waitClear(stop: () => Promise<boolean> | boolean = () => false): Promise<void> {
    await this.loaded;
    for (let until = this.until(); until; until = this.until()) {
      if (await stop()) return;
      const delay = Math.min(Math.max(0, until - Date.now()) + 1, CHALLENGE_POLL_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
