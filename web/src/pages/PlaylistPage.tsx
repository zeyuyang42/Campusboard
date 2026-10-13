import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { usePlaylist, usePlaylistMutations } from "../api/queries";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { ConfirmButton } from "../components/ConfirmButton";
import { PlaylistCover } from "../components/PlaylistCover";
import { formatTotal } from "../lib/format";
import { friendlyError } from "../lib/errors";
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
  if (error) return <div className="notice error">Couldn't load this playlist. {friendlyError(error)}</div>;
  if (isLoading || !pl) return <div className="empty">Loading…</div>;

  const total = pl.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const onMove = (from: number, to: number) => {
    const ids = pl.tracks.map((t) => t.playlist_track_id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    reorder.mutate({ id, ids });
  };
  const shufflePlay = () => {
    if (!shuffle) toggleShuffle();
    const playable = pl.tracks.filter((t) => t.streamable);
    playTracks(playable, Math.floor(Math.random() * Math.max(1, playable.length)));
  };

  return (
    <>
      <div className="page-title">
        <PlaylistCover artIds={pl.art_ids} />
        {editing !== null ? (
          <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); if (editing.trim()) rename.mutate({ id, name: editing.trim() }); setEditing(null); }}>
            <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
          </form>
        ) : (
          <button className="title-edit" onClick={() => setEditing(pl.name)} title="Rename">{pl.name}</button>
        )}
        <span className="count meta"><span>{pl.tracks.length} track{pl.tracks.length === 1 ? "" : "s"}</span><span>{formatTotal(total)}</span></span>
        <span className="actions">
          <PlayPauseAll tracks={pl.tracks} />
          <button className="btn" onClick={shufflePlay} disabled={!pl.tracks.some((t) => t.streamable)}><ShuffleIcon /> Shuffle</button>
          <ConfirmButton label="Delete" confirmLabel="Delete playlist" question={`Delete "${pl.name}"?`} onConfirm={async () => { await remove.mutateAsync(id); nav("/playlists"); }} />
        </span>
      </div>
      {pl.tracks.length === 0 ? (
        <div className="empty">Nothing here yet. Add tracks from any album or the Tracks tab using the ··· menu, or select several and choose Add to playlist.</div>
      ) : (
        <TrackList tracks={pl.tracks} showAlbum reorder={{ onMove, onRemove: (i) => removeTrack.mutate({ id, ptid: pl.tracks[i].playlist_track_id }), removeLabel: "Remove from playlist" }} />
      )}
    </>
  );
}
