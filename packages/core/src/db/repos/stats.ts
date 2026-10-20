// Listening stats (#94): top artists, albums and tags for a period, from the plays table.
// Read-only and built on the existing indexes; albums waiting out their Undo (#93) don't count.
import type { Db } from "../Db.js";
import { NOT_REMOVING } from "./albumRemoval.js";
import type { ListeningStats, StatsAlbum, StatsArtist, StatsCounts, StatsPeriod, StatsTag } from "../../types.js";

export const STATS_PERIODS: readonly StatsPeriod[] = ["month", "year", "all"];
export const STATS_LIMIT = 10;

/** A moment in the stored played_at format (UTC `YYYY-MM-DD HH:MM:SS`). */
const stored = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/**
 * The period's [from, to) bounds as stored played_at text: this month or this year in local
 * time (a play at 23:30 on the 31st belongs to the month it was on the user's clock), or null
 * for all time.
 */
export function periodBounds(period: StatsPeriod, now = new Date()): { from: string; to: string } | null {
  const y = now.getFullYear(), m = now.getMonth();
  if (period === "month") return { from: stored(new Date(y, m, 1)), to: stored(new Date(y, m + 1, 1)) };
  if (period === "year") return { from: stored(new Date(y, 0, 1)), to: stored(new Date(y + 1, 0, 1)) };
  return null;
}

/**
 * Per album in the period (`s`): counted plays and the summed track durations (TOTAL skips a
 * missing duration). One pass over plays, grouped by album; the album row then leaves out
 * pending removals. Params: [from, to] when bounded.
 */
const periodSql = (bounded: boolean) => `WITH pa AS (
    SELECT t.album_id AS album_id, COUNT(*) AS plays, TOTAL(t.duration) AS seconds
    FROM plays p JOIN tracks t ON t.id = p.track_id
    ${bounded ? "WHERE p.played_at >= ? AND p.played_at < ?" : ""}
    GROUP BY t.album_id
  ), s AS (
    SELECT pa.album_id, pa.plays, pa.seconds, al.artist_id, al.art_id, al.title, al.tags_json
    FROM pa JOIN albums al ON al.id = pa.album_id WHERE ${NOT_REMOVING}
  )`;

// Ties: more plays, then more time, then name (case folded), then id, so the order is stable.
const TOP = "ORDER BY plays DESC, seconds DESC";

/** The four statements; params are [from, to,] (limit). Exported for the query-plan test. */
export const statsSql = (bounded: boolean) => {
  const w = periodSql(bounded);
  return {
    totals: `${w} SELECT COALESCE(SUM(plays), 0) AS plays, TOTAL(seconds) AS seconds, COUNT(*) AS albums FROM s`,
    albums: `${w} SELECT s.album_id, s.title, ar.name AS artist_name, s.art_id, s.plays, s.seconds
      FROM s JOIN artists ar ON ar.id = s.artist_id
      ${TOP}, s.title COLLATE NOCASE, s.album_id LIMIT ?`,
    // The art is the artist's most played album in the period, looked up after the cut.
    artists: `${w} SELECT x.*, (SELECT s.art_id FROM s WHERE s.artist_id = x.artist_id ${TOP}, s.album_id LIMIT 1) AS art_id
      FROM (SELECT s.artist_id, ar.name, SUM(s.plays) AS plays, TOTAL(s.seconds) AS seconds
            FROM s JOIN artists ar ON ar.id = s.artist_id GROUP BY s.artist_id
            ${TOP}, ar.name COLLATE NOCASE, s.artist_id LIMIT ?) x
      ${TOP}, x.name COLLATE NOCASE, x.artist_id`,
    // An album counts once per tag, however many case variants of it it carries (as listTags).
    tags: `${w}, tg AS (
        SELECT s.album_id, s.art_id, MAX(s.plays) AS plays, MAX(s.seconds) AS seconds, MIN(trim(j.value)) AS tag
        FROM s, json_each(CASE WHEN json_valid(s.tags_json) THEN s.tags_json ELSE '[]' END) j
        WHERE j.type = 'text' AND trim(j.value) <> ''
        GROUP BY s.album_id, trim(j.value) COLLATE NOCASE
      )
      SELECT x.*, (SELECT tg.art_id FROM tg WHERE tg.tag = x.tag COLLATE NOCASE ${TOP}, tg.album_id LIMIT 1) AS art_id
      FROM (SELECT MIN(tag) AS tag, SUM(plays) AS plays, TOTAL(seconds) AS seconds FROM tg
            GROUP BY tag COLLATE NOCASE ${TOP}, MIN(tag) COLLATE NOCASE LIMIT ?) x
      ${TOP}, x.tag COLLATE NOCASE`,
  };
};

/**
 * Top artists, albums and tags (at most `limit` each) with plays and listening time, plus the
 * period's totals. Listening time is the full length of each counted play's track:
 * seconds_listened is only recorded up to the play threshold, so it would undercount.
 */
export async function listeningStats(db: Db, period: StatsPeriod, now = new Date(), limit = STATS_LIMIT): Promise<ListeningStats> {
  const b = periodBounds(period, now);
  const p = b ? [b.from, b.to] : [];
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const q = statsSql(!!b);
  const [totals, albums, artists, tags] = await Promise.all([
    db.get<StatsCounts & { albums: number }>(q.totals, p),
    db.select<StatsAlbum>(q.albums, [...p, n]),
    db.select<StatsArtist>(q.artists, [...p, n]),
    db.select<StatsTag>(q.tags, [...p, n]),
  ]);
  return { totals: totals ?? { plays: 0, seconds: 0, albums: 0 }, artists, albums, tags };
}
