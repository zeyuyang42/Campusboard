import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { normalizeBandcampUrl } from "@bc/core";
import { useImport, useJobs, useInvalidateLibrary } from "../api/queries";
import { JobProgress } from "../components/JobProgress";
import { friendlyError } from "../lib/errors";

export function ImportPage() {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const imp = useImport();
  const { data: jobs } = useJobs();
  const invalidate = useInvalidateLibrary();
  const nav = useNavigate();

  // Refresh library views whenever a job finishes.
  const activeCount = jobs?.filter((j) => j.status === "queued" || j.status === "running").length ?? 0;
  const prevActive = useRef(activeCount);
  useEffect(() => { if (prevActive.current > 0 && activeCount === 0) invalidate(); prevActive.current = activeCount; }, [activeCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const urls = url.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return;
    try {
      // A single artist URL opens the browse page so you can pick releases; everything else imports directly.
      if (urls.length === 1) {
        try { if (normalizeBandcampUrl(urls[0]).kind === "artist") { nav(`/browse?url=${encodeURIComponent(urls[0])}`); return; } } catch { /* fall through to the import error */ }
      }
      for (const u of urls) await imp.mutateAsync({ url: u });
      setUrl("");
    } catch (e) {
      setErr(friendlyError(e));
    }
  };

  return (
    <>
      <h1 className="page-title">Import from Bandcamp</h1>
      <form className="import-form" onSubmit={submit}>
        <input autoFocus placeholder="Paste an album, track or artist URL (e.g. https://artist.bandcamp.com/album/…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn primary" type="submit" disabled={imp.isPending || !url.trim()}>Import</button>
      </form>
      {err && <div className="notice error" style={{ marginBottom: 16 }}>{err}</div>}
      <p className="muted" style={{ marginTop: -8, marginBottom: 24 }}>
        Album and track pages import immediately. An artist or label URL opens their releases so you can choose what to import. Paste several album URLs separated by spaces or newlines to queue them all.
      </p>
      {jobs && jobs.length === 0 && <div className="empty">No imports yet.</div>}
      {jobs?.map((j) => <JobProgress key={j.id} job={j} />)}
      <div className="kbd-help">
        <span><kbd>Space</kbd> play/pause</span><span><kbd>←</kbd> <kbd>→</kbd> seek 5s</span><span><kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> previous/next</span><span><kbd>↑</kbd> <kbd>↓</kbd> volume</span><span><kbd>S</kbd> shuffle</span><span><kbd>R</kbd> repeat</span><span><kbd>Q</kbd> queue</span><span><kbd>N</kbd> now playing</span><span><kbd>/</kbd> search</span>
      </div>
    </>
  );
}
