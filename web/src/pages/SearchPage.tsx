import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useImport, useJob, useSearch, useInvalidateLibrary } from "../api/queries";
import type { SearchResult } from "@bc/core";
import { JobProgress } from "../components/JobProgress";
import { artUrl } from "../lib/art";
import { ExternalLink } from "../components/ExternalLink";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function SearchPage() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 350);
  const { data, isFetching, error } = useSearch(dq);
  const groups: { title: string; type: SearchResult["type"] }[] = [
    { title: "Artists & labels", type: "band" },
    { title: "Albums", type: "album" },
    { title: "Tracks", type: "track" },
  ];
  return (
    <>
      <h1 className="page-title">Search Bandcamp</h1>
      <input data-search-input className="search-input" autoFocus placeholder="Artist, album or track…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{String(error)}</div>}
      {isFetching && <div className="muted">Searching…</div>}
      <div className="results">
        {groups.map((g) => {
          const items = data?.filter((r) => r.type === g.type) ?? [];
          if (!items.length) return null;
          return (
            <div className="group" key={g.type}>
              <h3>{g.title}</h3>
              {items.map((r) => <Result key={`${r.type}-${r.id}`} r={r} />)}
            </div>
          );
        })}
        {data && data.length === 0 && dq.length >= 2 && !isFetching && <div className="empty">No results.</div>}
      </div>
    </>
  );
}

function Result({ r }: { r: SearchResult }) {
  const imp = useImport();
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job } = useJob(jobId);
  const invalidate = useInvalidateLibrary();
  useEffect(() => { if (job && (job.status === "done" || job.status === "failed")) invalidate(); }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Album/track results carry an `img` without the "a" prefix that real art URLs need; derive from art_id instead.
  const img = r.type === "band" ? r.img : artUrl(r.art_id, 7) ?? r.img;
  const add = async () => { const j = await imp.mutateAsync({ url: r.url }); setJobId(j.id); };
  const label = r.type === "band" ? "Import discography" : "Add";
  return (
    <div>
      <div className="result">
        {img ? <img src={img} alt="" loading="lazy" /> : <div />}
        <div>
          <div>{r.name}</div>
          <div className="sub">{r.type === "band" ? (r.location || "artist") : r.artist ?? ""}{r.type !== "band" && r.location ? ` · ${r.location}` : ""} · <ExternalLink href={r.url} className="muted">bandcamp ↗</ExternalLink></div>
        </div>
        {r.in_library && r.type !== "band" ? (
          <Link className="btn sm" to="/library">In library</Link>
        ) : (
          <button className="btn sm primary" onClick={add} disabled={imp.isPending || (!!job && (job.status === "queued" || job.status === "running"))}>
            {r.in_library ? "Re-import" : label}
          </button>
        )}
      </div>
      {job && <JobProgress job={job} compact />}
    </div>
  );
}
