import { useParams } from "react-router-dom";
import { useArtist } from "../api/queries";
import { AlbumCard } from "../components/AlbumCard";
import { ExternalIcon } from "../components/Icons";
import { ExternalLink } from "../components/ExternalLink";

export function ArtistPage() {
  const id = Number(useParams().id);
  const { data: artist, isLoading, error } = useArtist(id);
  if (error) return <div className="error">{String(error)}</div>;
  if (isLoading || !artist) return <div className="empty">Loading…</div>;
  return (
    <>
      <h1 className="page-title">
        {artist.name}
        <span className="count">{artist.albums.length} release{artist.albums.length === 1 ? "" : "s"}{artist.location ? ` · ${artist.location}` : ""}</span>
        <span className="spacer" />
        <ExternalLink className="btn sm" href={artist.url}>Bandcamp <ExternalIcon /></ExternalLink>
      </h1>
      <div className="grid">{artist.albums.map((a) => <AlbumCard key={a.id} album={a} showArtist={false} />)}</div>
    </>
  );
}
