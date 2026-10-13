import { Link, useNavigate } from "react-router-dom";
import { usePlaylists, usePlaylistMutations } from "../api/queries";
import { PlaylistCover } from "../components/PlaylistCover";
import { useState } from "react";

export function PlaylistsPage() {
  const { data, isLoading } = usePlaylists();
  const { create } = usePlaylistMutations();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const p = await create.mutateAsync(name.trim());
    nav(`/playlists/${p.id}`);
  };
  return (
    <>
      <h1 className="page-title">Playlists <span className="actions">{!creating && <button className="btn primary" onClick={() => setCreating(true)}>New playlist</button>}</span></h1>
      {creating && (
        <form className="inline-edit" onSubmit={submit} style={{ marginBottom: 18 }}>
          <input autoFocus placeholder="Playlist name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setCreating(false); }} />
          <button className="btn primary" type="submit" disabled={!name.trim()}>Create</button>
          <button className="btn" type="button" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      )}
      {isLoading ? <div className="empty">Loading…</div> : !data?.length ? <div className="empty">No playlists yet. Select tracks and choose Add to playlist, or create one here.</div> : (
        <div className="pl-list">
          {data.map((p) => (
            <Link key={p.id} to={`/playlists/${p.id}`}>
              <PlaylistCover artIds={p.art_ids} />
              <div style={{ minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div className="sub"><span>{p.track_count} track{p.track_count === 1 ? "" : "s"}</span></div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
