import type { Job } from "@bc/core";
import { useQueryClient } from "@tanstack/react-query";
import { getCore } from "../api/core";
import { keys, useChallengeUntil } from "../api/queries";
import { friendlyError } from "../lib/errors";
import { ChallengeNotice } from "./ChallengeNotice";

export function JobProgress({ job, compact = false }: { job: Job; compact?: boolean }) {
  const qc = useQueryClient();
  const active = job.status === "pending" || job.status === "queued" || job.status === "running";
  const { data: challengeUntil } = useChallengeUntil();
  const paused = active && !!challengeUntil;
  const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : active ? 0 : 100;
  const cancel = async () => { await (await getCore()).cancelJob(job.id); void qc.invalidateQueries({ queryKey: keys.jobs }); void qc.invalidateQueries({ queryKey: keys.job(job.id) }); };
  const failedItems = job.items?.filter((i) => i.status === "failed") ?? [];
  return (
    <div className="job">
      <div className="head">
        <span className={`status ${paused ? "paused" : job.status}`}>{paused ? "paused" : job.status}</span>
        <span className="muted" style={{ fontSize: 12 }}>{job.kind === "selection" ? "selected releases" : job.kind === "collection" ? "collection sync" : job.kind === "library" ? "library import" : job.kind === "download" ? "offline download" : job.kind}</span>
        <span className="url" title={job.input_url}>{job.input_url.replace(/^https?:\/\//, "")}</span>
        <span className="spacer" />
        {job.total > 0 && <span className="muted" style={{ fontSize: 12 }}>{job.done + job.failed} / {job.total}{job.failed ? ` · ${job.failed} failed` : ""}</span>}
        {active && <button className="btn sm" onClick={cancel}>Cancel</button>}
      </div>
      {(active || job.total > 1) && <div className="progress"><div className="fill" style={{ width: `${pct}%` }} /></div>}
      {/* The Import page shows one notice above its list; compact cards on Browse and Search carry their own. */}
      {paused && compact && <ChallengeNotice inline />}
      {job.error && <div className={job.status === "failed" ? "error" : "muted"} style={{ fontSize: 12, marginTop: 6 }}>{friendlyError(job.error)}</div>}
      {!compact && failedItems.length > 0 && (
        <div className="items">
          {failedItems.map((i) => <div key={i.id} className="fail">{i.url.replace(/^https?:\/\/[^/]+/, "")}: {friendlyError(i.error)}</div>)}
        </div>
      )}
    </div>
  );
}
