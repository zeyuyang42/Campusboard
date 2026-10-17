export type ScrapeErrorCode =
  | "invalid_url"
  | "not_bandcamp"
  | "client_challenge"
  /** A recent challenge put Bandcamp requests on hold; detail is { until: ms timestamp }. */
  | "challenge_cooldown"
  | "parse_failed"
  | "not_streamable"
  | "not_found"
  | "fetch_failed"
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
