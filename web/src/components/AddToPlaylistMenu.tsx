import { useEffect, useRef, useState } from "react";
import type { Track } from "@bc/shared";
import { usePlaylists, usePlaylistMutations } from "../api/queries";
import { usePlayer } from "../player/store";
import { MoreIcon } from "./Icons";

/** Per-track "..." menu: queue operations and add-to-playlist. */
export function TrackMenu({ tracks, extra }: { tracks: Track[]; extra?: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: playlists } = usePlaylists();
  const { addTracks, create } = usePlaylistMutations();
  const enqueueNext = usePlayer((s) => s.enqueueNext);
  const enqueueLast = usePlayer((s) => s.enqueueLast);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const playable = tracks.filter((t) => t.streamable);
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn(); setOpen(false); };
  const addNew = async () => {
    const name = window.prompt("New playlist name");
    if (!name?.trim()) return;
    const p = await create.mutateAsync(name.trim());
    await addTracks.mutateAsync({ id: p.id, trackIds: tracks.map((t) => t.id) });
  };

  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`icon-btn ${open ? "open" : ""}`} title="More" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}><MoreIcon /></button>
      {open && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <button disabled={!playable.length} onClick={act(() => enqueueNext(playable))}>Play next</button>
          <button disabled={!playable.length} onClick={act(() => enqueueLast(playable))}>Add to queue</button>
          <hr />
          <div className="label">Add to playlist</div>
          {playlists?.map((p) => (
            <button key={p.id} onClick={act(() => addTracks.mutate({ id: p.id, trackIds: tracks.map((t) => t.id) }))}>{p.name}</button>
          ))}
          <button onClick={act(() => void addNew())}>+ New playlist…</button>
          {extra && extra.length > 0 && <hr />}
          {extra?.map((x) => (
            <button key={x.label} className={x.danger ? "error" : ""} onClick={act(x.onClick)}>{x.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
