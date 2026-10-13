export type ScrapeErrorCode =
  | "invalid_url"
  | "not_bandcamp"
  | "client_challenge"
  | "parse_failed"
  | "not_streamable"
  | "not_found"
  | "fetch_failed";

export class ScrapeError extends Error {
  constructor(public code: ScrapeErrorCode, message: string, public detail?: unknown) {
    super(message);
    this.name = "ScrapeError";
  }
}
