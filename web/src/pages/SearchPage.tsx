import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useImport, useJob, useSearch, useInvalidateLibrary } from "../api/queries";
import type { SearchResult } from "@bc/core";
import { JobProgress } from "../components/JobProgress";
import { artUrl } from "../lib/art";
import { friendlyError } from "../lib/errors";
import { ExternalLink } from "../components/ExternalLink";
import { ReleasePlayButton, useReleasePreview } from "../components/ReleasePlayButton";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function SearchPage() {
  // ?q= (Search Bandcamp… in the command palette) starts the search with that text.
  const [params] = useSearchParams();
  const initial = params.get("q") ?? "";
  const [q, setQ] = useState(initial);
  // Each navigation to ?q= (also the same text again, after editing the field) refills it.
  const { key: navKey } = useLocation();
  useEffect(() => { if (initial) setQ(initial); }, [initial, navKey]);
  const dq = useDebounced(q, 350);
  const { data, isFetching, error } = useSearch(dq);
  const groups: { title: string; type: SearchResult["type"] }[] = [
    { title: "Artists and labels", type: "band" },
    { title: "Albums", type: "album" },
    { title: "Tracks", type: "track" },
  ];
  return (
    <>
      <h1 className="page-title">Search Bandcamp</h1>
      <input data-search-input className="search-input" autoFocus placeholder="Artist, album or track…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="notice error">Search isn't available right now. {friendlyError(error)}</div>}
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
        {data && data.length === 0 && dq.length >= 2 && !isFetching && <div className="empty">No results for “{dq}”. Try the artist name or a different spelling.</div>}
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
  const nav = useNavigate();
  const img = r.type === "band" ? r.img : artUrl(r.art_id, 7) ?? r.img;
  const add = async () => { const j = await imp.mutateAsync({ url: r.url }); setJobId(j.id); };
  const label = "Add";
  const preview = useReleasePreview(r.url, null, r.in_library);
  return (
    <div>
      <div className="result">
        {img ? <img src={img} alt="" loading="lazy" /> : <div />}
        <div>
          <div>{r.name}</div>
          <div className="sub">
            <span>{r.type === "band" ? (r.location || "Artist") : r.artist ?? ""}</span>
            {r.type !== "band" && r.location && <span>{r.location}</span>}
            <ExternalLink href={r.url} className="muted">Open on Bandcamp</ExternalLink>
          </div>
        </div>
        {r.type === "band" ? (
          <span className="row">
            <button className="btn sm primary" onClick={() => nav(`/browse?url=${encodeURIComponent(r.url)}`)}>Browse releases</button>
          </span>
        ) : (
          <span className="row result-actions">
            <ReleasePlayButton className="icon-btn" title={r.name} preview={preview} />
            {r.in_library ? (
              <Link className="btn sm" to="/library">In library</Link>
            ) : (
              <button className="btn sm primary" onClick={add} disabled={imp.isPending || (!!job && (job.status === "pending" || job.status === "queued" || job.status === "running"))}>{label}</button>
            )}
          </span>
        )}
      </div>
      {preview.error != null && <div className="release-error error result-error">{friendlyError(preview.error)}</div>}
      {job && <JobProgress job={job} compact />}
    </div>
  );
}
