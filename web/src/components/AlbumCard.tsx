import { Link } from "react-router-dom";
import type { Album } from "@bc/core";
import { ArtImage } from "./ArtImage";
import { PlayIcon } from "./Icons";
import { getCore } from "../api/core";
import { usePlayer } from "../player/store";
import { yearOf } from "../lib/format";

export function AlbumCard({ album, showArtist = true }: { album: Album; showArtist?: boolean }) {
  const playTracks = usePlayer((s) => s.playTracks);
  const play = async (e: React.MouseEvent) => {
    e.preventDefault();
    const full = await (await getCore()).album(album.id);
    if (full) playTracks(full.tracks.filter((t) => t.streamable));
  };
  const year = yearOf(album.release_date);
  return (
    <Link className="card" to={`/album/${album.id}`}>
      <div className="art">
        <ArtImage artId={album.art_id} size={16} alt="" />
        {album.item_type === "track" && <span className="badge">single</span>}
        {(album.streamable_count ?? 0) > 0 && (
          <button className="play" onClick={play} title="Play"><PlayIcon size={20} /></button>
        )}
      </div>
      <div className="title" title={album.title}>{album.title}</div>
      <div className="sub">{showArtist ? album.artist_name : ""}{showArtist && year ? " · " : ""}{year}</div>
    </Link>
  );
}
