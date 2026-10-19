import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { Track } from "@bc/core";
import { usePlayer } from "../player/store";
import { formatDuration, formatPlays } from "../lib/format";
import { useSelection } from "../lib/useSelection";
import { useRowDrag } from "../lib/useRowDrag";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent } from "../ui/menu";
import { SelectionBar } from "./SelectionBar";
import { PlayIcon, MoreIcon, SavedIcon } from "./Icons";

export interface TrackListProps {
  tracks: Track[];
  /** Show album/artist under the title (for playlists and the flat tracks view). */
  showAlbum?: boolean;
  /** Number rows by track_num instead of list position. */
  useTrackNum?: boolean;
  /** When set, rows can be dragged to reorder and removed. */
  reorder?: { onMove: (from: number, to: number) => void; onRemove: (index: number) => void; removeLabel?: string };
  onAlbumPage?: boolean;
  /**
   * The list is a pre-order album: its tracks that can't be streamed aren't out yet. The
   * release date when known (shown in their tooltip), or null.
   */
  availableOn?: string | null;
}

export function TrackList({ tracks, showAlbum = false, useTrackNum = false, reorder, onAlbumPage = false, availableOn }: TrackListProps) {
  const currentId = usePlayer((s) => s.queue[s.index]?.id);
  const status = usePlayer((s) => s.status);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const ids = tracks.map((t) => t.id);
  const sel = useSelection(ids);
  const drag = useRowDrag(reorder?.onMove ?? (() => {}));
  const actions = useTrackActions();
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tableRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "a" && tableRef.current?.contains(document.activeElement)) { e.preventDefault(); sel.selectAll(); }
      if (e.key === "Escape" && sel.selected.size) sel.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  const playFrom = (i: number) => {
    const t = tracks[i];
    if (!t.streamable) return;
    if (t.id === currentId) return toggle();
    const playable = tracks.filter((x) => x.streamable);
    playTracks(playable, playable.findIndex((x) => x.id === t.id));
  };
  const targets = (i: number): Track[] => (sel.selected.has(tracks[i].id) && sel.selected.size > 1 ? tracks.filter((t) => sel.selected.has(t.id)) : [tracks[i]]);
  const menuFor = (i: number) => {
    const ts = targets(i);
    const removeOpt = reorder && ts.length === 1 ? { label: reorder.removeLabel ?? "Remove from playlist", onSelect: () => reorder.onRemove(i) } : undefined;
    return actions(ts, { remove: removeOpt, onAlbumPage });
  };
  const selectedTracks = tracks.filter((t) => sel.selected.has(t.id));
  // The play-count column only exists when some row in this list has been played.
  const showPlays = tracks.some((t) => t.play_count);

  return (
    <>
      <table className="tracks" ref={tableRef} tabIndex={0} aria-multiselectable="true">
        <tbody>
          {tracks.map((t, i) => {
            const isCur = t.id === currentId;
            const playing = isCur && status === "playing";
            const rowKey = `${t.id}-${(t as { playlist_track_id?: number }).playlist_track_id ?? i}`;
            return (
              <tr
                key={rowKey}
                className={`${isCur ? "playing" : ""} ${!t.streamable ? "disabled" : ""} ${reorder ? drag.rowClass(i) : ""}`}
                aria-selected={sel.isSelected(t.id)}
                onMouseDown={(e) => sel.onRowMouseDown(e, t.id, i)}
                onDoubleClick={() => playFrom(i)}
                onContextMenu={(e) => { if (!sel.isSelected(t.id)) sel.onRowMouseDown({ ...e, button: 0 } as React.MouseEvent, t.id, i); openMenuFromEvent(e, menuFor(i)); }}
                {...(reorder ? drag.rowProps(i) : {})}
              >
                <td className="num">
                  {t.streamable ? (
                    <button onClick={(e) => { e.stopPropagation(); playFrom(i); }} onMouseDown={(e) => e.stopPropagation()} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : `Play ${t.title}`}>
                      {playing ? <span className="eq" /> : isCur ? <PlayIcon size={14} /> : <><span className="n">{useTrackNum ? t.track_num ?? i + 1 : i + 1}</span><span className="hover-play"><PlayIcon size={14} /></span></>}
                    </button>
                  ) : (
                    <span>{useTrackNum ? t.track_num ?? i + 1 : i + 1}</span>
                  )}
                </td>
                <td className="title" title={t.streamable ? undefined : availableOn ? `Available on ${availableOn}` : availableOn === null ? "Not out yet" : "Can't be streamed from Bandcamp"}>
                  <div>
                    {t.title}{!t.streamable && availableOn === undefined && <span className="muted"> (not streamable)</span>}
                    {t.downloaded && <span className="saved" title="Available offline" aria-label="Available offline"><SavedIcon /></span>}
                  </div>
                  {showAlbum && (
                    <div className="sub meta">
                      <span>{t.track_artist ?? t.artist_name}</span><Link to={`/album/${t.album_id}`} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>{t.album_title}</Link>
                    </div>
                  )}
                  {!showAlbum && t.track_artist && <div className="sub">{t.track_artist}</div>}
                </td>
                {showPlays && <td className="plays">{t.play_count ? formatPlays(t.play_count) : null}</td>}
                <td className="dur">{t.streamable || t.duration ? formatDuration(t.duration) : ""}</td>
                <td className="actions">
                  <button className="icon-btn" title="More" aria-label={`More actions for ${t.title}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => openMenuFromEvent(e, menuFor(i))}><MoreIcon /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <SelectionBar tracks={selectedTracks} onClear={sel.clear} />
    </>
  );
}

export function PlayPauseAll({ tracks }: { tracks: Track[] }) {
  const playTracks = usePlayer((s) => s.playTracks);
  const playable = tracks.filter((t) => t.streamable);
  return (
    <button className="btn primary" disabled={!playable.length} onClick={() => playTracks(playable)}>
      <PlayIcon size={16} /> Play
    </button>
  );
}
