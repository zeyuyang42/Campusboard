import { Link } from "react-router-dom";
import type { Album } from "@bc/core";
import { ArtImage } from "./ArtImage";
import { PlayIcon } from "./Icons";
import { getCore } from "../api/core";
import { usePlayer } from "../player/store";
import { yearOf } from "../lib/format";
import { useTrackActions } from "../lib/useTrackActions";
import { useMenu } from "../ui/menu";
import { useAlbumMutations } from "../api/queries";

/** `detail` replaces the release year under the title (e.g. a play count); "" shows nothing there. */
export function AlbumCard({ album, showArtist = true, detail }: { album: Album; showArtist?: boolean; detail?: string }) {
  const playTracks = usePlayer((s) => s.playTracks);
  const actions = useTrackActions();
  const { remove, refresh } = useAlbumMutations();
  const play = async (e: React.MouseEvent) => {
    e.preventDefault();
    const full = await (await getCore()).album(album.id);
    if (full) playTracks(full.tracks.filter((t) => t.streamable));
  };
  const menu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.persist?.();
    const at = e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : (e.currentTarget as HTMLElement);
    const full = await (await getCore()).album(album.id);
    if (!full) return;
    const content = actions(full.tracks, { onAlbumPage: false, remove: { label: "Remove from library", onSelect: () => remove.mutate(album.id) } });
    if ("items" in content) content.items.splice(content.items.length - 2, 0, { label: "Refresh from Bandcamp", onSelect: () => refresh.mutate(album.id) });
    useMenu.getState().show(at, content);
  };
  const second = detail ?? yearOf(album.release_date);
  return (
    <Link className="card" to={`/album/${album.id}`} onContextMenu={menu}>
      <div className="art">
        <ArtImage artId={album.art_id} size={16} alt="" />
        {album.item_type === "track" && <span className="badge">single</span>}
        {(album.streamable_count ?? 0) > 0 && (
          <button className="play" onClick={play} title={`Play ${album.title}`} aria-label={`Play ${album.title}`}><PlayIcon size={20} /></button>
        )}
      </div>
      <div className="title" title={album.title}>{album.title}</div>
      <div className="sub meta">{showArtist && <span>{album.artist_name}</span>}{second && <span>{second}</span>}</div>
    </Link>
  );
}
