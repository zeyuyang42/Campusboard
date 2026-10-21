import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { BrowseItem } from "@bc/core";
import { getCore } from "../api/core";
import { useImport, useJob, useInvalidateLibrary } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { ExternalLink } from "../components/ExternalLink";
import { ExternalIcon } from "../components/Icons";
import { JobProgress } from "../components/JobProgress";
import { ReleasePlayButton, useReleasePreview } from "../components/ReleasePlayButton";
import { friendlyError } from "../lib/errors";
import { plural } from "../lib/format";

/** An artist's or label's releases on Bandcamp, with checkboxes to import just the ones you want. */
export function BrowsePage() {
  const [params] = useSearchParams();
  const url = params.get("url") ?? "";
  const nav = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["browse", url], queryFn: async () => (await getCore()).browse(url), enabled: !!url, staleTime: 5 * 60_000 });
  const imp = useImport();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job } = useJob(jobId);
  const invalidate = useInvalidateLibrary();
  const [filter, setFilter] = useState("");

  const jobDone = job?.status === "done" || job?.status === "failed";
  useEffect(() => { if (jobDone) { invalidate(); void refetch(); setSelected(new Set()); } }, [jobDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => !q || i.title.toLowerCase().includes(q) || (i.artist ?? "").toLowerCase().includes(q));
  }, [data, filter]);
  const importable = items.filter((i) => !i.album_id);
  const toggle = (u: string) => setSelected((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const selectAll = () => setSelected(new Set(importable.map((i) => i.url)));

  const importSelected = async () => {
    const j = await (await getCore()).importSelection({ urls: [...selected], label: url });
    setJobId(j.id);
  };
  const importAll = async () => {
    const j = await imp.mutateAsync({ url });
    setJobId(j.id);
  };

  if (!url) return <div className="empty">Open an artist from Search, or paste an artist URL on the Import page.</div>;
  if (error) return <div className="notice error">Couldn't load this page. {friendlyError(error)}</div>;
  if (isLoading || !data) return <div className="empty">Loading releases from Bandcamp…</div>;

  const inLibrary = data.items.filter((i) => i.album_id).length;
  const busy = imp.isPending || (!!job && !jobDone);
  return (
    <>
      <div className="page-title">
        <span>{data.band?.name ?? new URL(data.url).hostname.split(".")[0]}</span>
        <span className="count meta">
          <span>{plural(data.items.length, "release")} on Bandcamp</span>
          {inLibrary > 0 && <span>{inLibrary} in your library</span>}
        </span>
        <span className="actions">
          <ExternalLink className="btn" href={data.url}>Open on Bandcamp <ExternalIcon /></ExternalLink>
          <button className="btn" disabled={busy || importable.length === 0} onClick={importAll}>Import all{importable.length ? ` (${importable.length})` : ""}</button>
        </span>
      </div>
      <div className="toolbar">
        <input placeholder="Filter releases" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }} />
        <button className="btn sm" onClick={selectAll} disabled={!importable.length}>Select all</button>
        <button className="btn sm ghost" onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
        <span className="spacer" />
        <button className="btn primary" disabled={busy || selected.size === 0} onClick={importSelected}>
          {selected.size ? `Import ${selected.size} selected` : "Import selected"}
        </button>
      </div>
      {job && <JobProgress job={job} compact />}
      {items.length === 0 ? (
        <div className="empty">{filter ? `Nothing matches “${filter}”.` : "No releases found on this page."}</div>
      ) : (
        <div className="grid browse-grid">
          {items.map((i) => <BrowseCard key={i.url} item={i} checked={selected.has(i.url)} onToggle={() => toggle(i.url)} onOpen={() => i.album_id && nav(`/album/${i.album_id}`)} />)}
        </div>
      )}
      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>Importing adds the release to your library and streams it from Bandcamp. <Link to="/import">Paste any other link on the Import page.</Link></p>
    </>
  );
}

function BrowseCard({ item, checked, onToggle, onOpen }: { item: BrowseItem; checked: boolean; onToggle: () => void; onOpen: () => void }) {
  const owned = !!item.album_id;
  const preview = useReleasePreview(item.url, item.album_id);
  return (
    <div className={`card browse-card ${checked ? "checked" : ""} ${owned ? "owned" : ""}`} onClick={owned ? onOpen : onToggle} role={owned ? "link" : "checkbox"} aria-checked={owned ? undefined : checked} tabIndex={0}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); owned ? onOpen() : onToggle(); } }}>
      <div className="art">
        <ArtImage artId={item.art_id} size={16} alt="" />
        {item.item_type === "track" && <span className="badge">single</span>}
        {owned ? <span className="badge right">In library</span> : <span className={`check ${checked ? "on" : ""}`} aria-hidden="true">{checked ? "✓" : ""}</span>}
        <ReleasePlayButton className="play" title={item.title} preview={preview} />
      </div>
      <div className="title" title={item.title}>{item.title}</div>
      {item.artist && <div className="sub">{item.artist}</div>}
      {preview.error != null && <div className="release-error error">{friendlyError(preview.error)}</div>}
    </div>
  );
}
