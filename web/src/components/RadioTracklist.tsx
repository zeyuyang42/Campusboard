import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { QueueTrack, RadioEntry } from "@bc/core";
import { useImport, useInvalidateLibrary, useJob } from "../api/queries";
import { usePlayer } from "../player/store";
import { useRadioNow } from "../player/radio";
import { ArtImage } from "./ArtImage";
import { ExternalLink } from "./ExternalLink";
import { friendlyError } from "../lib/errors";
import { formatDuration } from "../lib/format";

/**
 * An episode's featured tracks. The one under the playhead is marked and kept in view; its
 * time seeks there. Each links to its release: Open album once it is in the library, Import
 * before, and always Buy on Bandcamp.
 */
export function RadioTracklist({ cur, onOpenAlbum }: { cur: QueueTrack; onOpenAlbum?: () => void }) {
  const { show, index, isPending, error } = useRadioNow(cur);
  const seek = usePlayer((s) => s.seek);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const row = listRef.current?.children[index] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  if (error) return <div className="empty">Couldn't load the tracklist. {friendlyError(error)}</div>;
  if (isPending || !show) return null;
  if (!show.tracks.length) return <div className="empty">This episode has no tracklist.</div>;
  return (
    <ol className="radio-tracklist" ref={listRef}>
      {show.tracks.map((t, i) => (
        <RadioEntryRow key={`${t.timecode}-${i}`} entry={t} current={i === index} onSeek={() => seek(t.timecode)} onOpenAlbum={onOpenAlbum} />
      ))}
    </ol>
  );
}

function RadioEntryRow({ entry, current, onSeek, onOpenAlbum }: { entry: RadioEntry; current: boolean; onSeek: () => void; onOpenAlbum?: () => void }) {
  const imp = useImport();
  const invalidate = useInvalidateLibrary();
  const [jobId, setJobId] = useState<number | null>(null);
  const { data: job } = useJob(jobId);
  const [err, setErr] = useState<string | null>(null);
  const importing = imp.isPending || (!!job && (job.status === "pending" || job.status === "queued" || job.status === "running"));
  const failed = job?.status === "failed" ? (job.items?.[0]?.error ?? job.error ?? "Import failed") : null;
  // Done: refresh the library (and this tracklist, which then offers Open album).
  useEffect(() => { if (job?.status === "done") invalidate(); }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    if (!entry.url) return;
    setErr(null);
    try { setJobId((await imp.mutateAsync({ url: entry.url })).id); } catch (e) { setErr(friendlyError(e)); }
  };
  return (
    <li className={`radio-entry ${current ? "current" : ""}`} aria-current={current ? "true" : undefined}>
      <ArtImage artId={entry.art_id} size={7} alt="" />
      <div className="t">
        <div className="title selectable" title={entry.title}>{entry.title}</div>
        <div className="sub selectable" title={entry.album_title ? `${entry.artist}, ${entry.album_title}` : entry.artist}>
          {entry.artist}{entry.album_title && entry.album_title !== entry.title ? <span className="album">{entry.album_title}</span> : null}
        </div>
        {(err || failed) && <div className="error radio-entry-error" role="alert">{err ?? friendlyError(failed)}</div>}
      </div>
      <div className="radio-entry-actions">
        {entry.album_id ? (
          <Link className="btn sm ghost reveal" to={`/album/${entry.album_id}`} onClick={onOpenAlbum}>Open album</Link>
        ) : entry.url ? (
          <button className="btn sm ghost reveal" disabled={importing} onClick={start}>{importing ? "Importing…" : "Import"}</button>
        ) : null}
        {entry.url && <ExternalLink className="btn sm ghost buy" href={entry.url} title={entry.url}>Buy on Bandcamp</ExternalLink>}
      </div>
      <button className="radio-entry-time" title="Play from here" onClick={onSeek}>{formatDuration(entry.timecode)}</button>
    </li>
  );
}
