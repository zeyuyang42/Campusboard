import { Link, useNavigate, useParams } from "react-router-dom";
import { useAlbum, useAlbumMutations } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { ExternalIcon, MoreIcon } from "../components/Icons";
import { ExternalLink } from "../components/ExternalLink";
import { ConfirmButton } from "../components/ConfirmButton";
import { formatDate, formatTotal } from "../lib/format";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent } from "../ui/menu";

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, isLoading, error } = useAlbum(id);
  const { remove, refresh } = useAlbumMutations();
  const nav = useNavigate();
  const actions = useTrackActions();
  if (error) return <div className="error">{String(error)}</div>;
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
            {album.release_date ? `, released ${formatDate(album.release_date)}` : ""}
            {album.is_preorder ? ". Pre-order" : ""}
          </div>
          <div>{album.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
          <div className="actions">
            <PlayPauseAll tracks={album.tracks} />
            <button className="icon-btn" title="More" aria-label="More actions" onClick={(e) => openMenuFromEvent(e, actions(album.tracks, { onAlbumPage: true }))}><MoreIcon /></button>
            <ExternalLink className="btn" href={album.url}>Buy on Bandcamp <ExternalIcon /></ExternalLink>
            <button className="btn" onClick={() => refresh.mutate(album.id)} disabled={refresh.isPending}>{refresh.isPending ? "Refreshing…" : "Refresh"}</button>
            <ConfirmButton label="Remove" confirmLabel="Remove" question={`Remove "${album.title}" from your library?`} onConfirm={async () => { await remove.mutateAsync(album.id); nav("/library"); }} />
          </div>
        </div>
      </div>
      <TrackList tracks={album.tracks} useTrackNum onAlbumPage />
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
