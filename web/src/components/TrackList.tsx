import { useState } from "react";
import { Link } from "react-router-dom";
import type { Track } from "@bc/shared";
import { usePlayer } from "../player/store";
import { formatDuration } from "../lib/format";
import { TrackMenu } from "./AddToPlaylistMenu";
import { PlayIcon } from "./Icons";

export interface TrackListProps {
  tracks: Track[];
  /** Show album/artist under the title (for playlists and the flat tracks view). */
  showAlbum?: boolean;
  /** Show numbering from track_num instead of list position. */
  useTrackNum?: boolean;
  /** When set, rows can be dragged / moved and removed. */
  reorder?: { onMove: (from: number, to: number) => void; onRemove: (index: number) => void };
}

export function TrackList({ tracks, showAlbum = false, useTrackNum = false, reorder }: TrackListProps) {
  const currentId = usePlayer((s) => s.queue[s.index]?.id);
  const status = usePlayer((s) => s.status);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const playFrom = (i: number) => {
    const t = tracks[i];
    if (!t.streamable) return;
    if (t.id === currentId) return toggle();
    // Build the queue from this list, starting at the clicked track (skipping unplayable ones).
    const playable = tracks.filter((x) => x.streamable);
    playTracks(playable, playable.findIndex((x) => x.id === t.id));
  };

  return (
    <table className="tracks">
      <tbody>
        {tracks.map((t, i) => {
          const isCur = t.id === currentId;
          const playing = isCur && status === "playing";
          return (
            <tr
              key={`${t.id}-${(t as { playlist_track_id?: number }).playlist_track_id ?? i}`}
              className={`${isCur ? "playing" : ""} ${!t.streamable ? "disabled" : ""} ${drag === i ? "dragging" : ""} ${over === i && drag !== null && drag !== i ? "drop-target" : ""}`}
              onDoubleClick={() => playFrom(i)}
              draggable={!!reorder}
              onDragStart={reorder ? () => setDrag(i) : undefined}
              onDragOver={reorder ? (e) => { e.preventDefault(); setOver(i); } : undefined}
              onDragEnd={reorder ? () => { setDrag(null); setOver(null); } : undefined}
              onDrop={reorder ? (e) => { e.preventDefault(); if (drag !== null && drag !== i) reorder.onMove(drag, i); setDrag(null); setOver(null); } : undefined}
            >
              <td className="num">
                {t.streamable ? (
                  <button onClick={() => playFrom(i)} title={playing ? "Pause" : "Play"}>
                    {playing ? <span className="eq" /> : isCur ? <PlayIcon size={14} /> : <span className="n">{useTrackNum ? t.track_num ?? i + 1 : i + 1}</span>}
                  </button>
                ) : (
                  <span>{useTrackNum ? t.track_num ?? i + 1 : i + 1}</span>
                )}
              </td>
              <td className="title">
                <div>{t.title}{!t.streamable && <span className="muted"> · not streamable</span>}</div>
                {showAlbum && (
                  <div className="sub">
                    {t.track_artist ?? t.artist_name} · <Link to={`/album/${t.album_id}`} onClick={(e) => e.stopPropagation()}>{t.album_title}</Link>
                  </div>
                )}
                {!showAlbum && t.track_artist && <div className="sub">{t.track_artist}</div>}
              </td>
              <td className="dur">{formatDuration(t.duration)}</td>
              <td className="actions">
                {reorder && (
                  <>
                    <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => reorder.onMove(i, i - 1)}>↑</button>
                    <button className="icon-btn" title="Move down" disabled={i === tracks.length - 1} onClick={() => reorder.onMove(i, i + 1)}>↓</button>
                  </>
                )}
                <TrackMenu tracks={[t]} extra={reorder ? [{ label: "Remove from playlist", onClick: () => reorder.onRemove(i), danger: true }] : undefined} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
