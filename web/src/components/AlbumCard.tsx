import { memo } from "react";
import { Link } from "react-router-dom";
import type { Album } from "@bc/core";
import { ArtImage } from "./ArtImage";
import { PlayIcon } from "./Icons";
import { getCore } from "../api/core";
import { usePlayer } from "../player/store";
import { formatReleaseDate, yearOf } from "../lib/format";
import { useTrackActions } from "../lib/useTrackActions";
import { reopenMenuAs, useMenu } from "../ui/menu";
import { invalidateGroup } from "../api/queries";
import { archiveAlbumWithUndo, removeAlbumWithUndo, unarchiveAlbum } from "../lib/removals";

/** Re-scrape one album, then refresh the library views (what useAlbumMutations().refresh does, without a mutation per card). */
const refreshAlbum = (id: number) => void getCore().then((c) => c.refreshAlbum(id)).then(() => invalidateGroup("library")).catch(() => undefined);

/**
 * `detail` replaces the release year under the title (e.g. a play count); "" shows nothing there.
 * Memoised: a grid that re-renders for its filter text or sort keeps the cards whose album is unchanged.
 */
export const AlbumCard = memo(function AlbumCard({ album, showArtist = true, detail }: { album: Album; showArtist?: boolean; detail?: string }) {
  const playTracks = usePlayer((s) => s.playTracks);
  const actions = useTrackActions();
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
    const content = actions(full.tracks, { onAlbumPage: false, remove: { label: "Remove from library", onSelect: () => { void removeAlbumWithUndo(album); } } });
    if ("items" in content) {
      // Crates (#126) sit with "Add to playlist…"; Refresh and Archive go above Remove.
      const playlist = content.items.findIndex((it) => it.kind !== "separator" && it.kind !== "label" && it.label.endsWith("playlist…"));
      content.items.splice(playlist < 0 ? 0 : playlist + 1, 0, { label: "Add to crate…", onSelect: () => reopenMenuAs({ cratePicker: { albumIds: [album.id] } }) });
      content.items.splice(content.items.length - 2, 0,
        { label: "Refresh from Bandcamp", onSelect: () => refreshAlbum(album.id) },
        album.archived
          ? { label: "Unarchive", onSelect: () => { void unarchiveAlbum(album.id); } }
          : { label: "Archive", onSelect: () => { void archiveAlbumWithUndo(album); } },
      );
    }
    useMenu.getState().show(at, content);
  };
  // A pre-order shows when it comes out in place of the year (a `detail` still wins).
  const preorder = album.is_preorder && detail === undefined;
  const second = detail ?? (preorder ? (album.release_date ? `Pre-order, out ${formatReleaseDate(album.release_date, true)}` : "Pre-order") :yearOf(album.release_date));
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
      <div className="sub meta">{showArtist && <span>{album.artist_name}</span>}{second && <span className={preorder ? "preorder" : undefined}>{second}</span>}</div>
    </Link>
  );
});
