import { NavLink, useNavigate } from "react-router-dom";
import { usePlaylists, usePlaylistMutations } from "../api/queries";

export function Sidebar() {
  const { data: playlists } = usePlaylists();
  const { create } = usePlaylistMutations();
  const nav = useNavigate();
  const newPlaylist = async () => {
    const name = window.prompt("Playlist name");
    if (!name?.trim()) return;
    const p = await create.mutateAsync(name.trim());
    nav(`/playlists/${p.id}`);
  };
  return (
    <aside className="sidebar nav">
      <div className="brand"><span className="dot" /> Bandcamp Player</div>
      <NavLink to="/library">Library</NavLink>
      <NavLink to="/search">Search</NavLink>
      <NavLink to="/import">Import</NavLink>
      <div className="section">
        <span>Playlists</span>
        <button title="New playlist" onClick={newPlaylist}>+</button>
      </div>
      {playlists?.map((p) => (
        <NavLink key={p.id} to={`/playlists/${p.id}`}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>{p.track_count}</span>
        </NavLink>
      ))}
      {playlists && playlists.length === 0 && <div className="muted" style={{ padding: "4px 10px", fontSize: 12 }}>No playlists yet</div>}
    </aside>
  );
}
