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
export function yearOf(d: string | null | undefined): string {
  if (!d) return "";
  const t = Date.parse(d);
  return Number.isNaN(t) ? "" : String(new Date(t).getUTCFullYear());
}
/** "1 play", "3 plays". */
export const formatPlays = (n: number) => `${n} play${n === 1 ? "" : "s"}`;
