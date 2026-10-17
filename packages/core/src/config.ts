export const RATE_LIMIT_MS = 1000;
export const PAGE_CACHE_MS = 10 * 60 * 1000;
export const STREAM_SAFETY_MS = 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;
/** Art fetches for palette extraction bypass the queue, so they carry their own timeout. */
export const ART_FETCH_TIMEOUT_MS = 15_000;
/** page_cache rows older than this are pruned. */
export const PAGE_CACHE_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
/** page_cache keeps at most this many rows (newest by fetched_at) on top of the age limit. */
export const PAGE_CACHE_MAX_ROWS = 200;
/** How often cachedFetchText prunes while the app stays open (it also prunes at startup). */
export const PAGE_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Longest playlist name accepted, in characters, after normalisation. */
export const PLAYLIST_NAME_MAX = 100;
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
/** First pause after Bandcamp serves its "Client Challenge" page; the job runner retries once after it. */
export const CHALLENGE_BACKOFF_MS = 60_000;
/** Each further challenge soon after the last one doubles the pause, up to this. */
export const CHALLENGE_MAX_MS = 30 * 60 * 1000;
/** A challenge more than this long after the previous cooldown ended starts again from CHALLENGE_BACKOFF_MS. */
export const CHALLENGE_RESET_MS = 10 * 60 * 1000;
/** How often a job paused for a cooldown checks whether it was cancelled. */
export const CHALLENGE_POLL_MS = 1000;
/** settings key holding the persisted cooldown, so it survives an app restart. */
export const CHALLENGE_SETTING_KEY = "challenge_until";
