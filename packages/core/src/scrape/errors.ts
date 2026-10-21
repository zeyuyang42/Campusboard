export type ScrapeErrorCode =
  | "invalid_url"
  | "not_bandcamp"
  | "client_challenge"
  /** A recent challenge put Bandcamp requests on hold; detail is { until: ms timestamp }. */
  | "challenge_cooldown"
  | "parse_failed"
  | "not_streamable"
  | "not_found"
  /** detail { network: true } when the request never got an answer (offline, DNS, timeout). */
  | "fetch_failed"
  /** Offline copies (#2): the size limit in Settings > Storage is reached. */
  | "storage_full"
  /** Offline copies: writing the file failed (detail { full: true } when the disk is full). */
  | "disk_error"
  /** Offline copies: the audio CDN kept refusing an album's streams, even after a fresh page. */
  | "cdn_refused"
  /** Offline copies: this build or window has no offline folder. */
  | "offline_unavailable"
  /** The player: the network is down and the track has no offline copy. */
  | "offline"
  /** Settings: the Bandcamp username isn't one Bandcamp could have issued. */
  | "invalid_username"
  /** Settings: the pasted identity cookie isn't a single cookie value. */
  | "invalid_cookie"
  /** A collection sync was asked for without a username in Settings. */
  | "no_account";

export class ScrapeError extends Error {
  constructor(public code: ScrapeErrorCode, message: string, public detail?: unknown) {
    super(message);
    this.name = "ScrapeError";
  }
}

/** An error as job rows and logs record it: `[code] message` for a ScrapeError, else its text. */
export function describeError(e: unknown): string {
  return e instanceof ScrapeError ? `[${e.code}] ${e.message}` : String(e);
}
