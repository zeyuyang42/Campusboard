import { Link, useNavigate, useParams } from "react-router-dom";
import { useAlbum, useAlbumMutations } from "../api/queries";
import { ArtImage } from "../components/ArtImage";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { TrackMenu } from "../components/AddToPlaylistMenu";
import { ExternalIcon } from "../components/Icons";
import { formatDate, formatTotal } from "../lib/format";

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, isLoading, error } = useAlbum(id);
  const { remove, refresh } = useAlbumMutations();
  const nav = useNavigate();
  if (error) return <div className="error">{String(error)}</div>;
  if (isLoading || !album) return <div className="empty">Loading…</div>;

  const total = album.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const del = async () => {
    if (!window.confirm(`Remove "${album.title}" from your library?`)) return;
    await remove.mutateAsync(album.id);
    nav("/library");
  };
  const artistId = album.artist_id;

  return (
    <>
      <div className="album-head">
        <ArtImage className="art" artId={album.art_id} size={10} alt="" />
        <div>
          <div className="muted" style={{ textTransform: "uppercase", fontSize: 12, letterSpacing: ".08em" }}>{album.item_type === "track" ? "Single" : "Album"}</div>
          <h1>{album.title}</h1>
          <div className="artist"><Link to={`/artist/${artistId}`}>{album.artist_name}</Link></div>
          <div className="meta">
            {album.release_date ? `${formatDate(album.release_date)} · ` : ""}{album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}, {formatTotal(total)}
            {album.is_preorder ? " · pre-order" : ""}
          </div>
          <div>{album.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
          <div className="actions">
            <PlayPauseAll tracks={album.tracks} />
            <TrackMenu tracks={album.tracks} />
            <a className="btn" href={album.url} target="_blank" rel="noreferrer">Buy on Bandcamp <ExternalIcon /></a>
            <button className="btn" onClick={() => refresh.mutate(album.id)} disabled={refresh.isPending}>{refresh.isPending ? "Refreshing…" : "Refresh"}</button>
            <button className="btn danger" onClick={del}>Remove</button>
          </div>
        </div>
      </div>
      <TrackList tracks={album.tracks} useTrackNum />
      {album.about && (
        <details className="about-wrap">
          <summary>About</summary>
          <div className="about">{album.about}</div>
          {album.credits && <div className="about">{album.credits}</div>}
        </details>
      )}
    </>
  );
}
