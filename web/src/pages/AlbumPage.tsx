import { Link, useNavigate, useParams } from "react-router-dom";
import type { AlbumWithTracks, Job } from "@bc/core";
import { removeAlbumWithUndo } from "../lib/removals";
import { cancelJob, useAlbum, useAlbumMutations, useJobs, useOfflineMutations, useOfflineStats } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { ExternalIcon, MoreIcon } from "../components/Icons";
import { ExternalLink } from "../components/ExternalLink";
import { AlbumNotes } from "../components/AlbumNotes";
import { TagLinks } from "../components/TagLinks";
import { formatReleaseDate, formatTotal } from "../lib/format";
import { friendlyError } from "../lib/errors";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent } from "../ui/menu";

const activeJob = (j: Job) => j.status === "pending" || j.status === "queued" || j.status === "running";

function offlineCounts(album: AlbumWithTracks) {
  return { saved: album.tracks.filter((t) => t.downloaded).length, streamable: album.tracks.filter((t) => t.streamable).length };
}

/** How much of the album has offline copies (#2), under the title like "Purchased". */
function OfflineNote({ album }: { album: AlbumWithTracks }) {
  const { saved, streamable } = offlineCounts(album);
  if (!saved) return null;
  return <div className="offline-note">{saved >= streamable ? "Available offline" : `${saved} of ${streamable} tracks available offline`}</div>;
}

/**
 * Make available offline / Remove download (#2). A download is a job in the import queue:
 * one track at a time at the usual polite pace, so progress shows here until it finishes.
 */
function OfflineAction({ album }: { album: AlbumWithTracks }) {
  const { data: stats } = useOfflineStats();
  const { data: jobs } = useJobs();
  const { downloadAlbum, removeAlbum } = useOfflineMutations();
  const mine = jobs?.filter((j) => j.kind === "download" && j.input_url === album.url) ?? [];
  const job = mine.find(activeJob);
  const { saved, streamable } = offlineCounts(album);
  if (!stats?.available || (!streamable && !saved)) return null;
  if (job) {
    return (
      <span className="offline-progress">
        <span className="muted">Downloading {Math.min(job.done + job.failed + 1, job.total)} of {job.total}…</span>
        <button className="btn sm" onClick={() => { void cancelJob(job.id); }}>Stop</button>
      </span>
    );
  }
  // The latest finished download, when it left tracks out (the size limit, a failed track).
  const last = mine[0];
  const why = last && saved < streamable && last.status !== "cancelled" && (last.failed > 0 || last.status === "failed") ? (last.error ?? "Some tracks couldn't be downloaded.") : null;
  const error = downloadAlbum.error ?? removeAlbum.error;
  return (
    <>
      {saved < streamable && (
        <button className="btn" disabled={downloadAlbum.isPending} onClick={() => downloadAlbum.mutate(album.id)}>
          {saved ? "Download the rest" : "Make available offline"}
        </button>
      )}
      {saved > 0 && <button className="btn" disabled={removeAlbum.isPending} onClick={() => removeAlbum.mutate(album.id)}>Remove download</button>}
      {(error || why) && <span className="muted offline-why">{friendlyError(error ?? why)}</span>}
    </>
  );
}

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, isLoading, error } = useAlbum(id);
  const { refresh } = useAlbumMutations();
  const nav = useNavigate();
  const actions = useTrackActions();
  if (error) return <div className="notice error">Couldn't load this album. {friendlyError(error)}</div>;
  if (isLoading || !album) return <div className="empty">Loading…</div>;

  const total = album.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  return (
    <>
      <div className="album-head">
        <ArtImage className="art" artId={album.art_id} size={10} alt="" />
        <div>
          <h1>{album.title}</h1>
          <div className="artist"><Link to={`/artist/${album.artist_id}`}>{album.artist_name}</Link></div>
          <div className="meta-line">
            {album.tracks.length === 1 ? "Single" : `${album.tracks.length} tracks`}, {formatTotal(total)}
            {album.release_date && !album.is_preorder ? `, released ${formatReleaseDate(album.release_date)}` : ""}
          </div>
          {album.is_preorder && (
            <div className="preorder-note">
              Pre-order{album.release_date ? `, out ${formatReleaseDate(album.release_date)}` : ""}
              {album.tracks.some((t) => t.streamable) ? "" : ". Nothing to stream yet"}
            </div>
          )}
          {album.owned && <div className="owned-note">Purchased</div>}
          <OfflineNote album={album} />
          <TagLinks tags={album.tags} />
          <AlbumNotes key={album.id} albumId={album.id} />
          <div className="actions">
            <PlayPauseAll tracks={album.tracks} />
            <button className="icon-btn" title="More" aria-label="More actions" onClick={(e) => openMenuFromEvent(e, actions(album.tracks, { onAlbumPage: true }))}><MoreIcon /></button>
            <ExternalLink className="btn" href={album.url}>Buy on Bandcamp <ExternalIcon /></ExternalLink>
            <OfflineAction album={album} />
            <button className="btn" onClick={() => refresh.mutate(album.id)} disabled={refresh.isPending}>{refresh.isPending ? "Refreshing…" : "Refresh"}</button>
            <button className="btn danger" onClick={async () => { if (await removeAlbumWithUndo(album)) nav("/library"); }}>Remove</button>
          </div>
        </div>
      </div>
      <TrackList tracks={album.tracks} useTrackNum onAlbumPage availableOn={album.is_preorder ? formatReleaseDate(album.release_date) || null : undefined} />
      {album.about && (
        <details className="about-wrap">
          <summary>About this release</summary>
          <div className="about">{album.about}</div>
          {album.credits && <div className="about">{album.credits}</div>}
        </details>
      )}
    </>
  );
}
