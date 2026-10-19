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
/** New releases: each library artist's /music page is checked at most this often. */
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The background checker's first look comes this long after launch, never at startup. */
export const RELEASE_CHECK_START_DELAY_MS = 3 * 60 * 1000;
/** Then one artist (one request at most) per tick, so N artists cost N requests a day, spread out. */
export const RELEASE_CHECK_TICK_MS = 3 * 60 * 1000;
/** settings key for the new-releases checker: { enabled: boolean } (missing means on). */
export const RELEASE_CHECK_SETTING_KEY = "release_check";
/** Background collection refresh: the account's lists are synced automatically at most this often. */
export const COLLECTION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Its first look comes this long after launch (after the new-releases checker's), never at startup. */
export const COLLECTION_REFRESH_START_DELAY_MS = 5 * 60 * 1000;
/** Then it looks every this often whether a refresh is due and the app is idle. */
export const COLLECTION_REFRESH_TICK_MS = 10 * 60 * 1000;
/** settings key: { enabled?: boolean; last_auto_at?: number } (missing `enabled` means on). */
export const COLLECTION_REFRESH_SETTING_KEY = "collection_refresh";
