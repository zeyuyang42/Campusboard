import { CHALLENGE_BACKOFF_MS, CHALLENGE_MAX_MS, CHALLENGE_RESET_MS } from "../config.js";
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

const valid = (s: unknown): s is ChallengeState =>
  !!s && typeof s === "object" && Number.isFinite((s as ChallengeState).until) &&
  Number.isFinite((s as ChallengeState).cooldownMs) && (s as ChallengeState).cooldownMs > 0;

/** "14:05" in local time. */
export const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

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
      ? store.load().then((s) => { if (valid(s)) this.state = s; }, () => {})
      : Promise.resolve();
  }

  /** Resolves once the persisted state has been read. */
  ready(): Promise<void> { return this.loaded; }

  /** When the cooldown ends (ms timestamp), or null when requests may go out. */
  until(now = Date.now()): number | null {
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

  /** Sleep until the cooldown, including any extension made meanwhile, is over. */
  async waitClear(): Promise<void> {
    await this.loaded;
    for (let until = this.until(); until; until = this.until()) {
      await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()) + 1));
    }
  }
}
