import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { StatsCounts, StatsPeriod } from "@bc/core";
import { useListeningStats } from "../api/queries";
import { friendlyError } from "../lib/errors";
import { formatPlays, formatTotal } from "../lib/format";
import { libraryTagPath } from "../lib/navigation";
import { ArtImage } from "./ArtImage";
import { PlayHistory } from "./PlayHistory";

const PERIODS: { value: StatsPeriod; label: string; none: string }[] = [
  { value: "month", label: "This month", none: "No plays this month yet." },
  { value: "year", label: "This year", none: "No plays this year yet." },
  { value: "all", label: "All time", none: "Nothing played yet." },
];
const isPeriod = (v: string | null): v is StatsPeriod => PERIODS.some((p) => p.value === v);

/**
 * The Library's History tab: the plays list (#86) or Listening stats (#94). Both choices live in
 * the address (?view=stats&period=year), so going back returns to the same view.
 */
export function HistoryTab() {
  const [params, setParams] = useSearchParams();
  const stats = params.get("view") === "stats";
  const p = params.get("period");
  const period: StatsPeriod = isPeriod(p) ? p : "month";
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v == null) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };
  return (
    <>
      <div className="toolbar history-bar">
        <div className="segmented" role="group" aria-label="History view">
          <button className={stats ? "" : "on"} aria-pressed={!stats} onClick={() => set({ view: null })}>List</button>
          <button className={stats ? "on" : ""} aria-pressed={stats} onClick={() => set({ view: "stats" })}>Stats</button>
        </div>
        {stats && (
          <select aria-label="Period" value={period} onChange={(e) => set({ period: e.target.value === "month" ? null : e.target.value })}>
            {PERIODS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>
      {stats ? <ListeningStats period={period} /> : <PlayHistory />}
    </>
  );
}

/** Top artists, albums and tags for a period: plain ranked lists from the play history. */
export function ListeningStats({ period }: { period: StatsPeriod }) {
  const { data, isLoading, error } = useListeningStats(period);
  if (error) return <div className="notice error">Couldn't work out your listening stats. {friendlyError(error)}</div>;
  if (isLoading || !data) return <div className="empty">Loading…</div>;
  if (!data.totals.plays) {
    return (
      <div className="stats">
        <div className="empty">
          {PERIODS.find((o) => o.value === period)!.none} A track counts once you've listened to half of it,
          or four minutes. Radio episodes aren't recorded.
        </div>
      </div>
    );
  }
  const { totals } = data;
  return (
    <div className="stats">
      <p className="stats-total">
        {formatPlays(totals.plays)} across {totals.albums} album{totals.albums === 1 ? "" : "s"}, {formatTotal(totals.seconds)} listened.
      </p>
      <div className="stats-lists">
        <Ranked title="Top artists">
          {data.artists.map((a) => (
            <Row key={a.artist_id} artId={a.art_id} counts={a}>
              <Link className="name selectable" to={`/artist/${a.artist_id}`}>{a.name}</Link>
            </Row>
          ))}
        </Ranked>
        <Ranked title="Top albums">
          {data.albums.map((a) => (
            <Row key={a.album_id} artId={a.art_id} counts={a}>
              <Link className="name selectable" to={`/album/${a.album_id}`}>{a.title}</Link>
              <div className="sub selectable">{a.artist_name}</div>
            </Row>
          ))}
        </Ranked>
        <Ranked title="Top tags">
          {data.tags.length
            ? data.tags.map((t) => (
              <Row key={t.tag} artId={t.art_id} counts={t}>
                <Link className="name selectable" to={libraryTagPath(t.tag)}>{t.tag}</Link>
              </Row>
            ))
            : <li className="none muted">The albums played have no tags.</li>}
        </Ranked>
      </div>
      <p className="stats-note muted">Time is the full length of each counted track. Radio episodes aren't recorded.</p>
    </div>
  );
}

function Ranked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <ol>{children}</ol>
    </section>
  );
}

function Row({ artId, counts, children }: { artId: number | null; counts: StatsCounts; children: ReactNode }) {
  return (
    <li>
      <ArtImage className="art" artId={artId} size={7} alt="" />
      <div className="t">{children}</div>
      <div className="n selectable">
        <div>{formatPlays(counts.plays)}</div>
        <div className="muted">{formatTotal(counts.seconds)}</div>
      </div>
    </li>
  );
}
