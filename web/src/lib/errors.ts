import { clockTime } from "@bc/core";

/** Turn errors from core (ScrapeError codes) or job items ("[code] message") into plain sentences. */
const MESSAGES: Record<string, string> = {
  challenge_cooldown: "Bandcamp asked us to slow down. Try again in a few minutes.",
  client_challenge: "Bandcamp asked for a browser check. Wait a few minutes and try again.",
  parse_failed: "Bandcamp's page looked different than expected. Try again later; if it keeps happening, the app needs an update.",
  fetch_failed: "Couldn't reach Bandcamp. Check your connection and try again.",
  not_found: "That page doesn't exist on Bandcamp.",
  not_bandcamp: "That page isn't on Bandcamp. Paste an album, track or artist URL like https://artist.bandcamp.com/album/name, or the same page on the artist's own domain.",
  invalid_url: "That doesn't look like a Bandcamp link. Paste an album, track or artist URL like https://artist.bandcamp.com/album/name.",
  not_streamable: "This track can't be streamed from Bandcamp.",
  invalid_playlist_name: "Give the playlist a name.",
  invalid_username: "That doesn't look like a Bandcamp username. It's the last part of your fan page address, bandcamp.com/username.",
  invalid_cookie: "That doesn't look like the identity cookie. Copy the value of the cookie named identity for bandcamp.com.",
  no_account: "Add your Bandcamp username in Settings first.",
};

export function friendlyError(err: unknown, fallback = "Something went wrong."): string {
  // The cooldown error carries its end time; say when to try again rather than "a few minutes".
  const until = typeof err === "object" && err && (err as { code?: unknown }).code === "challenge_cooldown" ? (err as { detail?: { until?: unknown } }).detail?.until : undefined;
  if (typeof until === "number") return `Bandcamp asked us to slow down. Try again after ${clockTime(until)}.`;
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : typeof err === "string" ? err.match(/^\[(\w+)\]/)?.[1] : undefined;
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (typeof err === "string" && err.trim()) return err.replace(/^\[\w+\]\s*/, "");
  const msg = err instanceof Error ? err.message : "";
  if (/schema mismatch|not valid JSON|No data-tralbum/i.test(msg)) return MESSAGES.parse_failed;
  if (/fetch|network|timeout|HTTP \d/i.test(msg)) return MESSAGES.fetch_failed;
  return fallback;
}
