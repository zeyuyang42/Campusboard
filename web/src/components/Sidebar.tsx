import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useCrateMutations, useCrates, useNewReleaseCount, usePlaylists, usePlaylistMutations } from "../api/queries";
import { PlaylistCover } from "./PlaylistCover";
import { useRef, useState } from "react";
import { useUi } from "../ui/store";
import { normalizeCrateName, normalizePlaylistName, CRATE_NAME_MAX, PLAYLIST_NAME_MAX, type Crate } from "@bc/core";
import { friendlyError } from "../lib/errors";
import { libraryCratePath } from "../lib/navigation";
import { openMenuFromEvent } from "../ui/menu";
import { deleteCrateWithUndo } from "../lib/removals";

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
  // The crate on screen (#126): the Library grid narrowed to it, which is not the Library entry's own page.
  const loc = useLocation();
  const crateOnScreen = loc.pathname.startsWith("/library") ? Number(new URLSearchParams(loc.search).get("crate")) || 0 : 0;
  return (
    <aside className={`sidebar nav ${open ? "open" : ""}`}>
      <div className="brand" data-tauri-drag-region><span className="dot" /><span>Campusboard</span></div>
      <NavLink to="/library" title="Library" className={({ isActive }) => (isActive && !crateOnScreen ? "active" : "")}><IconLibrary /><span className="label">Library</span></NavLink>
      <NavLink to="/search" title="Search"><IconSearch /><span className="label">Search</span></NavLink>
      <NavLink to="/discover" title="Discover"><IconDiscover /><span className="label">Discover</span></NavLink>
      <NavLink to="/import" title="Import"><IconImport /><span className="label">Import</span></NavLink>
      <NavLink to="/playlists" title="Playlists" end><IconPlaylists /><span className="label">Playlists</span></NavLink>
      <NavLink to="/releases" title={newCount ? `New releases (${newCount})` : "New releases"}>
        <IconNew /><span className="label">New releases</span>
        {!!newCount && <><span className="spacer" /><span className="count" aria-label={`${newCount} new`}>{newCount}</span></>}
      </NavLink>
      <NavLink to="/radio" title="Radio"><IconRadio /><span className="label">Radio</span></NavLink>
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
      <Crates onScreen={crateOnScreen} />
      <div className="bottom">
        <NavLink to="/settings" title="Settings"><IconSettings /><span className="label">Settings</span></NavLink>
      </div>
    </aside>
  );
}

/**
 * Crates (#126): the user's own album groups, under the playlists. A crate opens the Library's
 * Albums grid narrowed to it. Right-click a crate to rename it in place or delete it (Undo).
 */
function Crates({ onScreen }: { onScreen: number }) {
  const { data: crates } = useCrates();
  const { create, rename } = useCrateMutations();
  const nav = useNavigate();
  const creating = useUi((s) => s.creatingCrate);
  const setCreating = useUi((s) => s.setCreatingCrate);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const busy = useRef(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const clean = normalizeCrateName(name);
    if (!clean) { setCreating(false); setName(""); return; }
    busy.current = true;
    try {
      const c = await create.mutateAsync(clean);
      setName(""); setError(null); setCreating(false);
      nav(libraryCratePath(c.id));
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the crate."));
    } finally {
      busy.current = false;
    }
  };
  // Enter commits, Esc or leaving the field cancels, as the playlist title edit does.
  const commitRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const clean = normalizeCrateName(renaming.name);
    const current = crates?.find((c) => c.id === renaming.id);
    if (clean && current && clean !== current.name) rename.mutate({ id: renaming.id, name: clean });
    setRenaming(null);
  };
  const menu = (e: React.MouseEvent, c: Crate) => openMenuFromEvent(e, {
    items: [
      { label: "Rename", onSelect: () => setRenaming({ id: c.id, name: c.name }) },
      { kind: "separator" },
      { label: "Delete crate", danger: true, onSelect: () => { void deleteCrateWithUndo(c).then((ok) => { if (ok && onScreen === c.id) nav("/library"); }); } },
    ],
  });
  return (
    <>
      <div className="section">
        <span>Crates</span>
        <button title="New crate" onClick={() => setCreating(true)} aria-label="New crate">+</button>
      </div>
      {creating && (
        <form onSubmit={submit} style={{ padding: "0 4px 6px" }}>
          <input autoFocus placeholder="Crate name" maxLength={CRATE_NAME_MAX} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onBlur={() => { if (!normalizeCrateName(name)) { setCreating(false); setName(""); } }} onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setName(""); setError(null); } }} style={{ width: "100%" }} />
          {error && <div className="error" role="alert" style={{ fontSize: 12, padding: "4px 2px 0" }}>{error}</div>}
        </form>
      )}
      {crates?.map((c) => renaming?.id === c.id ? (
        <form key={c.id} onSubmit={commitRename} style={{ padding: "0 4px 6px" }}>
          <input autoFocus aria-label={`Rename ${c.name}`} maxLength={CRATE_NAME_MAX} value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onBlur={() => setRenaming(null)} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }} style={{ width: "100%" }} />
        </form>
      ) : (
        <Link key={c.id} to={libraryCratePath(c.id)} title={c.name} className={onScreen === c.id ? "active" : ""} onContextMenu={(e) => menu(e, c)} data-crate={c.id}>
          <PlaylistCover artIds={c.art_ids} size="sm" />
          <span className="pl-name">{c.name}</span>
          <span className="spacer" />
          <span className="count">{c.album_count}</span>
        </Link>
      ))}
      {rename.isError && <div className="error" role="alert" style={{ fontSize: 12, padding: "4px 14px 0" }}>{friendlyError(rename.error, "Couldn't rename the crate.")}</div>}
    </>
  );
}

const I = ({ d }: { d: string }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const IconLibrary = () => <I d="M4 5h3v14H4zM10 5h3v14h-3zM16 6l4-1 3 13-4 1z" />;
const IconSearch = () => <I d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />;
const IconDiscover = () => <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z" />;
const IconImport = () => <I d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" />;
const IconNew = () => <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 3v4M16 5h4" />;
const IconRadio = () => <I d="M4 10h16v10H4zM8 10l9-6M8 15h4M16 15h.01" />;
const IconPlaylists = () => <I d="M4 6h12M4 12h12M4 18h8M18 12v7a2 2 0 1 1-2-2h2z" />;
const IconSettings = () => <I d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />;
