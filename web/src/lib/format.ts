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
/** "1 play", "3 plays". */
export const formatPlays = (n: number) => `${n} play${n === 1 ? "" : "s"}`;
