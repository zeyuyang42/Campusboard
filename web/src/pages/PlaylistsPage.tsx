import { Link, useNavigate } from "react-router-dom";
import { usePlaylists, usePlaylistMutations } from "../api/queries";

export function PlaylistsPage() {
  const { data, isLoading } = usePlaylists();
  const { create } = usePlaylistMutations();
  const nav = useNavigate();
  const newPlaylist = async () => {
    const name = window.prompt("Playlist name");
    if (!name?.trim()) return;
    const p = await create.mutateAsync(name.trim());
    nav(`/playlists/${p.id}`);
  };
  return (
    <>
      <h1 className="page-title">Playlists <span className="spacer" /><button className="btn primary" onClick={newPlaylist}>New playlist</button></h1>
      {isLoading ? <div className="empty">Loading…</div> : !data?.length ? <div className="empty">No playlists yet.</div> : (
        <div className="pl-list">
          {data.map((p) => (
            <Link key={p.id} to={`/playlists/${p.id}`}>
              <div>{p.name}</div>
              <div className="sub">{p.track_count} track{p.track_count === 1 ? "" : "s"}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
