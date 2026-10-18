import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { NewRelease } from "@bc/core";
import { useImport, useJob, useNewReleases, useReleaseCheckStatus, useReleaseMutations } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { ConfirmButton } from "../components/ConfirmButton";
import { ExternalLink } from "../components/ExternalLink";
import { friendlyError } from "../lib/errors";
import { formatDate } from "../lib/format";

/** Releases that library artists put out after their first check, to import or dismiss. */
export function NewReleasesPage() {
  const { data: items, isLoading, error } = useNewReleases();
  const { data: status } = useReleaseCheckStatus();
  const { dismiss } = useReleaseMutations();

  if (error) return <div className="notice error">Couldn't load new releases. {friendlyError(error)}</div>;
  if (isLoading || !items) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1 className="page-title">
        New releases
        {items.length > 0 && <span className="count">{items.length}</span>}
        {items.length > 1 && (
          <span className="actions">
            <ConfirmButton className="btn sm" label="Dismiss all" confirmLabel="Dismiss all" question={`Dismiss all ${items.length}?`} onConfirm={() => dismiss.mutateAsync(items.map((i) => i.id)).then(() => undefined)} />
          </span>
        )}
      </h1>
      {items.length === 0 ? (
        <div className="empty">
          {status && !status.enabled
            ? <>Checking for new releases is turned off. <Link to="/settings#releases">Turn it on in Settings.</Link></>
            : <>Nothing new yet. The app looks at each artist in your library about once a day while it's open, and lists releases that appear after the first look.</>}
        </div>
      ) : (
        <div className="grid">{items.map((r) => <ReleaseCard key={r.id} release={r} onDismiss={() => dismiss.mutate([r.id])} />)}</div>
      )}
    </>
  );
}

function ReleaseCard({ release, onDismiss }: { release: NewRelease; onDismiss: () => void }) {
  const imp = useImport();
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job } = useJob(jobId);
  const [err, setErr] = useState<string | null>(null);
  const importing = imp.isPending || (!!job && (job.status === "queued" || job.status === "running"));
  const failed = job?.status === "failed" ? (job.items?.[0]?.error ?? job.error ?? "Import failed") : null;
  // Imported: the list drops it by URL, but a single whose track already sits in a library
  // album keeps its own URL out of the library, so settle it here either way.
  const imported = job?.status === "done" && job.done > 0;
  useEffect(() => { if (imported) onDismiss(); }, [imported]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setErr(null);
    try { setJobId((await imp.mutateAsync({ url: release.url })).id); } catch (e) { setErr(friendlyError(e)); }
  };
  return (
    <div className="card release-card">
      <ExternalLink className="art" href={release.url} title="Open on Bandcamp">
        <ArtImage artId={release.art_id} size={16} alt="" />
        {release.item_type === "track" && <span className="badge">single</span>}
      </ExternalLink>
      <div className="title selectable" title={release.title}>{release.title}</div>
      <div className="sub"><Link to={`/artist/${release.artist_id}`}>{release.artist_name}</Link></div>
      <div className="sub">Found {formatDate(`${release.first_seen.replace(" ", "T")}Z`)}</div>
      <div className="release-actions">
        <button className="btn sm" disabled={importing} onClick={start}>{importing ? "Importing…" : "Import"}</button>
        <button className="btn sm ghost" disabled={importing} onClick={onDismiss}>Dismiss</button>
      </div>
      {(err || failed) && <div className="error release-error" role="alert">{err ?? friendlyError(failed)}</div>}
    </div>
  );
}
