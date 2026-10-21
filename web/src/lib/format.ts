import { releaseTime } from "@bc/core";

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "–:––";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
export function formatTotal(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
}
export function formatDate(d: string | null | undefined): string {
  if (!d) return "";
  const t = Date.parse(d);
  return Number.isNaN(t) ? d : new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
/**
 * A Bandcamp release date ("30 Oct 2026 00:00:00 GMT") as a calendar date. Formatted in UTC:
 * the date is midnight GMT, which local time would show as the day before west of Greenwich.
 * `short` leaves out the year when it is this year.
 */
export function formatReleaseDate(d: string | null | undefined, short = false): string {
  const t = releaseTime(d);
  if (t == null) return d ?? "";
  const sameYear = new Date(t).getUTCFullYear() === new Date().getUTCFullYear();
  return new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(short && sameYear ? {} : { year: "numeric" }) });
}
export function yearOf(d: string | null | undefined): string {
  if (!d) return "";
  const t = Date.parse(d);
  return Number.isNaN(t) ? "" : String(new Date(t).getUTCFullYear());
}
/** "1 track", "3 tracks"; `many` for an irregular plural ("1 wishlist item", "2 wishlist items"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "1 play", "3 plays". */
export const formatPlays = (n: number) => plural(n, "play");
/** A local timestamp (ISO string or epoch ms) for "Last synced …" lines: medium date, short time. */
export const formatDateTime = (at: string | number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
/** Decimal units, as Finder shows sizes: 1 MB = 1,000,000 bytes. */
export function formatBytes(n: number): string {
  // At most three significant digits, no trailing zeros: 193 KB, 4.5 MB, 1 GB, 1.25 GB.
  const fmt = (x: number) => String(Number(x.toPrecision(3)));
  if (n < 1e6) return `${fmt(Math.max(n, 0) / 1e3)} KB`;
  if (n < 1e9) return `${fmt(n / 1e6)} MB`;
  return `${fmt(n / 1e9)} GB`;
}
