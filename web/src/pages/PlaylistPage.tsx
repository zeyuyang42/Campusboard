import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { usePlaylist, usePlaylistMutations } from "../api/queries";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { formatTotal } from "../lib/format";
import { usePlayer } from "../player/store";
import { ShuffleIcon } from "../components/Icons";

export function PlaylistPage() {
  const id = Number(useParams().id);
  const { data: pl, isLoading, error } = usePlaylist(id);
  const { rename, remove, reorder, removeTrack } = usePlaylistMutations();
  const nav = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const playTracks = usePlayer((s) => s.playTracks);
  const shuffle = usePlayer((s) => s.shuffle);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  if (error) return <div className="error">{String(error)}</div>;
  if (isLoading || !pl) return <div className="empty">Loading…</div>;

  const total = pl.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const onMove = (from: number, to: number) => {
    const ids = pl.tracks.map((t) => t.playlist_track_id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    reorder.mutate({ id, ids });
  };
  const del = async () => {
    if (!window.confirm(`Delete playlist "${pl.name}"?`)) return;
    await remove.mutateAsync(id);
    nav("/playlists");
  };
  const shufflePlay = () => {
    if (!shuffle) toggleShuffle();
    playTracks(pl.tracks.filter((t) => t.streamable), Math.floor(Math.random() * Math.max(1, pl.tracks.length)));
  };

  return (
    <>
      <h1 className="page-title">
        {editing !== null ? (
          <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); if (editing.trim()) rename.mutate({ id, name: editing.trim() }); setEditing(null); }}>
            <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => setEditing(null)} />
          </form>
        ) : (
          <span onDoubleClick={() => setEditing(pl.name)} title="Double-click to rename">{pl.name}</span>
        )}
        <span className="count">{pl.tracks.length} track{pl.tracks.length === 1 ? "" : "s"} · {formatTotal(total)}</span>
        <span className="spacer" />
        <PlayPauseAll tracks={pl.tracks} />
        <button className="btn" onClick={shufflePlay} disabled={!pl.tracks.some((t) => t.streamable)}><ShuffleIcon /> Shuffle</button>
        <button className="btn" onClick={() => setEditing(pl.name)}>Rename</button>
        <button className="btn danger" onClick={del}>Delete</button>
      </h1>
      {pl.tracks.length === 0 ? (
        <div className="empty">Empty playlist. Use the ··· menu on any track to add it here.</div>
      ) : (
        <TrackList tracks={pl.tracks} showAlbum reorder={{ onMove, onRemove: (i) => removeTrack.mutate({ id, ptid: pl.tracks[i].playlist_track_id }) }} />
      )}
    </>
  );
}
