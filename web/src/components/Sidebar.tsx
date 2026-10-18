import { NavLink, useNavigate } from "react-router-dom";
import { useNewReleaseCount, usePlaylists, usePlaylistMutations } from "../api/queries";
import { PlaylistCover } from "./PlaylistCover";
import { useRef, useState } from "react";
import { useUi } from "../ui/store";
import { normalizePlaylistName, PLAYLIST_NAME_MAX } from "@bc/core";
import { friendlyError } from "../lib/errors";

export function Sidebar({ open }: { open: boolean }) {
  const { data: playlists } = usePlaylists();
  const { data: newCount } = useNewReleaseCount();
  const { create } = usePlaylistMutations();
  const nav = useNavigate();
  const creating = useUi((s) => s.creatingPlaylist);
  const setCreating = useUi((s) => s.setCreatingPlaylist);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return; // a second Enter while the first create is in flight
    const clean = normalizePlaylistName(name);
    if (!clean) { setCreating(false); setName(""); return; }
    busy.current = true;
    try {
      const p = await create.mutateAsync(clean);
      setName(""); setError(null); setCreating(false);
      nav(`/playlists/${p.id}`);
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the playlist."));
    } finally {
      busy.current = false;
    }
  };
  return (
    <aside className={`sidebar nav ${open ? "open" : ""}`}>
      <div className="brand" data-tauri-drag-region><span className="dot" /><span>Bandcamp Player</span></div>
      <NavLink to="/library" title="Library"><IconLibrary /><span className="label">Library</span></NavLink>
      <NavLink to="/search" title="Search"><IconSearch /><span className="label">Search</span></NavLink>
      <NavLink to="/import" title="Import"><IconImport /><span className="label">Import</span></NavLink>
      <NavLink to="/playlists" title="Playlists" end><IconPlaylists /><span className="label">Playlists</span></NavLink>
      <NavLink to="/releases" title={newCount ? `New releases (${newCount})` : "New releases"}>
        <IconNew /><span className="label">New releases</span>
        {!!newCount && <><span className="spacer" /><span className="count" aria-label={`${newCount} new`}>{newCount}</span></>}
      </NavLink>
      <div className="section">
        <span>Your playlists</span>
        <button title="New playlist" onClick={() => setCreating(true)} aria-label="New playlist">+</button>
      </div>
      {creating && (
        <form onSubmit={submit} style={{ padding: "0 4px 6px" }}>
          <input autoFocus placeholder="Playlist name" maxLength={PLAYLIST_NAME_MAX} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onBlur={() => { if (!normalizePlaylistName(name)) { setCreating(false); setName(""); } }} onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setName(""); setError(null); } }} style={{ width: "100%" }} />
          {error && <div className="error" role="alert" style={{ fontSize: 12, padding: "4px 2px 0" }}>{error}</div>}
        </form>
      )}
      {playlists?.map((p) => (
        <NavLink key={p.id} to={`/playlists/${p.id}`} title={p.name}>
          <PlaylistCover artIds={p.art_ids} size="sm" />
          <span className="pl-name">{p.name}</span>
          <span className="spacer" />
          <span className="count">{p.track_count}</span>
        </NavLink>
      ))}
      <div className="bottom">
        <NavLink to="/settings" title="Settings"><IconSettings /><span className="label">Settings</span></NavLink>
      </div>
    </aside>
  );
}

const I = ({ d }: { d: string }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const IconLibrary = () => <I d="M4 5h3v14H4zM10 5h3v14h-3zM16 6l4-1 3 13-4 1z" />;
const IconSearch = () => <I d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />;
const IconImport = () => <I d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" />;
const IconNew = () => <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 3v4M16 5h4" />;
const IconPlaylists = () => <I d="M4 6h12M4 12h12M4 18h8M18 12v7a2 2 0 1 1-2-2h2z" />;
const IconSettings = () => <I d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />;
