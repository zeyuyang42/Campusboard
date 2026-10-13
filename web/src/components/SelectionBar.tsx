import type { Track } from "@bc/core";
import { usePlayer } from "../player/store";
import { useMenu } from "../ui/menu";

export function SelectionBar({ tracks, onClear, extra }: { tracks: Track[]; onClear: () => void; extra?: { label: string; onClick: () => void; danger?: boolean } }) {
  const playable = tracks.filter((t) => t.streamable);
  const { enqueueNext, enqueueLast, playTracks } = usePlayer.getState();
  const show = useMenu((s) => s.show);
  if (tracks.length < 2) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected tracks">
      <span>{tracks.length} tracks selected</span>
      <button className="btn sm" disabled={!playable.length} onClick={() => playTracks(playable)}>Play</button>
      <button className="btn sm" disabled={!playable.length} onClick={() => enqueueNext(playable)}>Play next</button>
      <button className="btn sm" disabled={!playable.length} onClick={() => enqueueLast(playable)}>Add to queue</button>
      <button className="btn sm" onClick={(e) => show(e.currentTarget, { playlistPicker: { trackIds: tracks.map((t) => t.id) } })}>Add to playlist</button>
      {extra && <button className={`btn sm ${extra.danger ? "danger" : ""}`} onClick={extra.onClick}>{extra.label}</button>}
      <button className="btn sm ghost" onClick={onClear}>Clear</button>
    </div>
  );
}
