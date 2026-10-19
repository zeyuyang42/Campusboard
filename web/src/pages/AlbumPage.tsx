import { Link, useNavigate, useParams } from "react-router-dom";
import { useAlbum, useAlbumMutations } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { ExternalIcon, MoreIcon } from "../components/Icons";
import { ExternalLink } from "../components/ExternalLink";
import { ConfirmButton } from "../components/ConfirmButton";
import { formatReleaseDate, formatTotal } from "../lib/format";
import { friendlyError } from "../lib/errors";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent } from "../ui/menu";

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, isLoading, error } = useAlbum(id);
  const { remove, refresh } = useAlbumMutations();
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
