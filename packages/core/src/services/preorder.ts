/**
 * Pre-order albums (#37). Bandcamp marks them with `is_preorder` and a future
 * `album_release_date`; tracks that aren't out yet have `file: null` (see AGENTS.md), so they
 * are stored as not streamable. Once the release date has passed, one re-fetch picks up the
 * full album: the new-releases checker does it (releaseWatch.ts), one album per tick.
 */

import { sqlTimeIso } from "../db/Db.js";

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/**
 * Bandcamp's release dates ("30 Oct 2026 00:00:00 GMT") as unix ms, or null. Parsed by hand so
 * it doesn't depend on the engine's Date.parse; anything else falls back to Date.parse.
 */
export function releaseTime(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(d.trim());
  if (m) {
    const mon = MONTHS.indexOf(m[2]);
    if (mon >= 0 && mon % 3 === 0) return Date.UTC(Number(m[3]), mon / 3, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
}

/** The library's own timestamps (`YYYY-MM-DD HH:MM:SS`, UTC) as unix ms, or null. */
export function dbTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(sqlTimeIso(s));
  return Number.isNaN(t) ? null : t;
}

/**
 * How long after the release date the re-check waits. Release dates are midnight GMT, and a
 * page fetched right then may still say pre-order; half a day later it has flipped.
 */
export const PREORDER_RECHECK_GRACE_MS = 12 * 60 * 60 * 1000;

export interface PreorderInfo {
  is_preorder: boolean;
  release_date: string | null;
  fetched_at: string | null;
}

/**
 * True when a pre-order album should be fetched again: its release date (plus the grace) has
 * passed and the stored page is from before that. One fetch after that point settles it, so a
 * release Bandcamp delays never turns into a fetch on every check.
 */
export function preorderRecheckDue(a: PreorderInfo, now: number): boolean {
  if (!a.is_preorder) return false;
  const rel = releaseTime(a.release_date);
  if (rel == null) return false;
  const due = rel + PREORDER_RECHECK_GRACE_MS;
  if (now < due) return false;
  const fetched = dbTime(a.fetched_at);
  return fetched == null || fetched < due;
}
