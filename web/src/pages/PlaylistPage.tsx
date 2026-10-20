import { useState } from "react";
import { normalizePlaylistName, PLAYLIST_NAME_MAX, type PlaylistWithTracks, type Track } from "@bc/core";
import { useNavigate, useParams } from "react-router-dom";
import { usePlaylist, usePlaylistMutations } from "../api/queries";
import { getCore } from "../api/core";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { ConfirmButton } from "../components/ConfirmButton";
import { PlaylistCover } from "../components/PlaylistCover";
import { SmartRuleEditor } from "../components/SmartRuleEditor";
import { formatTotal } from "../lib/format";
import { friendlyError } from "../lib/errors";
import { playAllTracks, shuffleAllTracks } from "../lib/bulkPlay";
import { usePlayer } from "../player/store";
import { PlayIcon, ShuffleIcon } from "../components/Icons";

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
          <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); const name = normalizePlaylistName(editing); if (name && name !== pl.name) rename.mutate({ id, name }); setEditing(null); }}>
            <input autoFocus maxLength={PLAYLIST_NAME_MAX} value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
          </form>
        ) : (
          <button className="title-edit" onClick={() => { rename.reset(); setEditing(pl.name); }} title="Rename">{pl.name}</button>
        )}
        {pl.smart && <span className="smart-mark" title="Fills itself from a rule each time it opens or plays">Smart</span>}
        {rename.isError && editing === null && <span className="error" role="alert">{friendlyError(rename.error, "Couldn't rename the playlist.")}</span>}
        <span className="count meta"><span>{pl.tracks.length} track{pl.tracks.length === 1 ? "" : "s"}</span><span>{formatTotal(total)}</span></span>
        {!pl.smart && (
          <span className="actions">
            <PlayPauseAll tracks={pl.tracks} />
            <button className="btn" onClick={shufflePlay} disabled={!pl.tracks.some((t) => t.streamable)}><ShuffleIcon /> Shuffle</button>
            <ConfirmButton label="Delete" confirmLabel="Delete playlist" question={`Delete "${pl.name}"?`} onConfirm={async () => { await remove.mutateAsync(id); nav("/playlists"); }} />
          </span>
        )}
      </div>
      {pl.smart ? <SmartBody pl={pl} onDelete={async () => { await remove.mutateAsync(id); nav("/playlists"); }} /> : pl.tracks.length === 0 ? (
        <div className="empty">Nothing here yet. Add tracks from any album or the Tracks tab using the ··· menu, or select several and choose Add to playlist.</div>
      ) : (
        <TrackList tracks={pl.tracks} showAlbum reorder={{ onMove, onRemove: (i) => removeTrack.mutate({ id, ptid: pl.tracks[i].playlist_track_id }), removeLabel: "Remove from playlist" }} />
      )}
    </>
  );
}

/**
 * A smart playlist (#84): Play and Shuffle evaluate the rule again at that moment (like the
 * Library's bulk bar, capped at the queue's limit), Edit rule opens the inline editor, and
 * the tracks can't be reordered or removed by hand.
 */
function SmartBody({ pl, onDelete }: { pl: PlaylistWithTracks; onDelete: () => Promise<void> }) {
  const { setRule } = usePlaylistMutations();
  const [editingRule, setEditingRule] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (act: (t: Track[]) => string | null) => {
    if (busy || !pl.rule) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setNote(act(await (await getCore()).smartTracks(pl.rule)));
    } catch (e) {
      setError(friendlyError(e, "Couldn't read this playlist's tracks."));
    } finally {
      setBusy(false);
    }
  };
  const playable = pl.tracks.some((t) => t.streamable);
  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label="Smart playlist">
        <button className="btn sm" disabled={busy || !playable} onClick={() => void run(playAllTracks)}><PlayIcon size={14} /> Play</button>
        <button className="btn sm" disabled={busy || !playable} onClick={() => void run(shuffleAllTracks)}><ShuffleIcon /> Shuffle</button>
        {!editingRule && <button className="btn sm" onClick={() => setEditingRule(true)}>Edit rule</button>}
        <ConfirmButton label="Delete" className="btn sm danger" confirmClassName="btn sm danger" confirmLabel="Delete playlist" question={`Delete "${pl.name}"?`} onConfirm={onDelete} />
        {error && <span className="error" role="alert">{error}</span>}
        {note && !error && <span className="muted" role="status">{note}</span>}
      </div>
      {editingRule && (
        <SmartRuleEditor
          rule={pl.rule}
          name={null}
          saveLabel="Save rule"
          onCancel={() => setEditingRule(false)}
          onSave={async (rule) => { await setRule.mutateAsync({ id: pl.id, rule }); setEditingRule(false); }}
        />
      )}
      {pl.tracks.length === 0 ? (
        <div className="empty">{pl.rule ? "No tracks match this rule right now. Edit the rule, or rate, tag and play more albums." : "This playlist's rule couldn't be read. Edit the rule to set it again."}</div>
      ) : (
        <TrackList tracks={pl.tracks} showAlbum />
      )}
    </>
  );
}
