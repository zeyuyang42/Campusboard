import type { HistoryEntry } from "@bc/core";

/** A plays.played_at value (UTC, "YYYY-MM-DD HH:MM:SS") as a Date. */
export const playedDate = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export interface HistoryDay { key: string; label: string; entries: HistoryEntry[] }

/**
 * Consecutive plays grouped by local calendar day, labelled Today, Yesterday, then dates
 * (with the year only when it isn't this year). Entries are expected newest first.
 */
export function groupByDay(entries: HistoryEntry[], now = new Date(), locale?: string): HistoryDay[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const days: HistoryDay[] = [];
  for (const e of entries) {
    const d = playedDate(e.played_at);
    const key = dayKey(d);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      const label = key === today ? "Today" : key === yesterday ? "Yesterday"
        : d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
      day = { key, label, entries: [] };
      days.push(day);
    }
    day.entries.push(e);
  }
  return days;
}

/** The time of day a play counted, e.g. "9:41 PM". */
export const playedTime = (s: string, locale?: string) => playedDate(s).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
