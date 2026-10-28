import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenu, type MenuItem } from "../ui/menu";
import { useCrateMutations, useCrates, usePlaylists, usePlaylistMutations } from "../api/queries";
import { getCore } from "../api/core";
import { normalizeCrateName, normalizePlaylistName, CRATE_NAME_MAX, PLAYLIST_NAME_MAX } from "@bc/core";
import { friendlyError } from "../lib/errors";
import { plural } from "../lib/format";

/** Renders the single app menu (context menu, playlist picker or crate picker) with keyboard support. */
export function MenuHost() {
  const { open, x, y, content, close } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(x - ("items" in content ? r.width : r.width), window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) === x ? x : left, top });
  }, [open, x, y, content]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (!ref.current) return;
      const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), input'));
      const i = focusables.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") { e.preventDefault(); focusables[(i + 1) % focusables.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); focusables[(i - 1 + focusables.length) % focusables.length]?.focus(); }
      else if (e.key === "Home") { e.preventDefault(); focusables[0]?.focus(); }
      else if (e.key === "End") { e.preventDefault(); focusables[focusables.length - 1]?.focus(); }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), input')?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); clearTimeout(t); };
  }, [open, content, close]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className="menu fixed" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
      {"items" in content ? <Items items={content.items} />
        : "playlistPicker" in content ? <PlaylistPicker trackIds={content.playlistPicker.trackIds} />
        : <CratePicker albumIds={content.cratePicker.albumIds} />}
    </div>,
    document.body,
  );
}

function Items({ items }: { items: MenuItem[] }) {
  const close = useMenu((s) => s.close);
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "separator") return <hr key={i} />;
        if (it.kind === "label") return <div key={i} className="label">{it.label}</div>;
        return (
          <button key={i} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => { close(); it.onSelect(); }}>
            <span>{it.label}</span>{it.hint && <span className="spacer muted" style={{ textAlign: "right", fontSize: 12 }}>{it.hint}</span>}
          </button>
        );
      })}
    </>
  );
}

function PlaylistPicker({ trackIds }: { trackIds: number[] }) {
  const close = useMenu((s) => s.close);
  const { data: playlists } = usePlaylists();
  const { addTracks, create } = usePlaylistMutations();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [containing, setContaining] = useState<Set<number>>(new Set());
  useEffect(() => { void getCore().then((c) => c.playlistsContaining(trackIds)).then(setContaining); }, [trackIds]);
  // Smart playlists (#84) fill themselves from a rule: they take no tracks by hand.
  const manual = (playlists ?? []).filter((p) => !p.smart);
  const shown = manual.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  const add = async (id: number) => { close(); await addTracks.mutateAsync({ id, trackIds }); };
  // Guards against a second Enter while a create is in flight, and remembers a playlist
  // that was created but not filled so a retry only re-adds the tracks.
  const busy = useRef(false);
  const created = useRef<{ id: number; name: string } | null>(null);
  const createAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const clean = normalizePlaylistName(name);
    if (!clean) return;
    busy.current = true;
    try {
      if (!created.current || created.current.name !== clean) {
        try {
          const p = await create.mutateAsync(clean);
          created.current = { id: p.id, name: clean };
        } catch (err) {
          setError(friendlyError(err, "Couldn't create the playlist."));
          return;
        }
      }
      try {
        await addTracks.mutateAsync({ id: created.current.id, trackIds });
        close();
      } catch (err) {
        setError(`Created "${clean}" but couldn't add the tracks. Press Return to try again. ${friendlyError(err, "")}`.trim());
      }
    } finally {
      busy.current = false;
    }
  };
  const n = trackIds.length;
  return (
    <>
      <div className="label">Add {n === 1 ? "to playlist" : `${n} tracks to playlist`}</div>
      {manual.length > 8 && <input placeholder="Filter playlists" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {shown.map((p) => (
        <button key={p.id} role="menuitem" onClick={() => void add(p.id)}>
          <span style={{ width: 14, display: "inline-block" }}>{containing.has(p.id) ? "✓" : ""}</span>
          <span>{p.name}</span>
        </button>
      ))}
      {shown.length === 0 && !creating && <div className="label">No playlists yet</div>}
      <hr />
      {creating ? (
        <form onSubmit={createAndAdd}>
          <input autoFocus placeholder="New playlist name" maxLength={PLAYLIST_NAME_MAX} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }} />
          {error && <div className="label error" role="alert">{error}</div>}
        </form>
      ) : (
        <button role="menuitem" onClick={() => setCreating(true)}><span style={{ width: 14, display: "inline-block" }}>+</span><span>New playlist…</span></button>
      )}
    </>
  );
}

/**
 * The crate picker (#126): one row per crate with a mark (✓ every album is in it, – some
 * are, nothing otherwise). A click toggles the albums in or out and keeps the menu open, so
 * an album can be put in several crates at once; "New crate…" creates one and adds them.
 */
function CratePicker({ albumIds }: { albumIds: number[] }) {
  const close = useMenu((s) => s.close);
  const { data: crates } = useCrates();
  const { add, remove, create } = useCrateMutations();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Map<number, number>>(new Map());
  const n = albumIds.length;
  const reload = () => getCore().then((c) => c.cratesContaining(albumIds)).then(setMarks);
  useEffect(() => { void reload(); }, [albumIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (crates ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  const busy = useRef(false);
  const toggle = async (id: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const all = (marks.get(id) ?? 0) >= n;
      if (all) await remove.mutateAsync({ id, albumIds });
      else await add.mutateAsync({ id, albumIds });
      await reload();
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "Couldn't change the crate."));
    } finally {
      busy.current = false;
    }
  };
  const created = useRef<{ id: number; name: string } | null>(null);
  const createAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const clean = normalizeCrateName(name);
    if (!clean) return;
    busy.current = true;
    try {
      if (!created.current || created.current.name !== clean) {
        try {
          const c = await create.mutateAsync(clean);
          created.current = { id: c.id, name: clean };
        } catch (err) {
          setError(friendlyError(err, "Couldn't create the crate."));
          return;
        }
      }
      try {
        await add.mutateAsync({ id: created.current.id, albumIds });
        close();
      } catch (err) {
        setError(`Created "${clean}" but couldn't add the albums. Press Return to try again. ${friendlyError(err, "")}`.trim());
      }
    } finally {
      busy.current = false;
    }
  };
  const mark = (id: number) => { const k = marks.get(id) ?? 0; return k >= n ? "✓" : k > 0 ? "–" : ""; };
  return (
    <>
      <div className="label">{n === 1 ? "Add to crate" : `Add ${plural(n, "album")} to crate`}</div>
      {(crates?.length ?? 0) > 8 && <input placeholder="Filter crates" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {shown.map((c) => (
        <button key={c.id} role="menuitem" onClick={() => void toggle(c.id)} aria-label={`${c.name}${mark(c.id) === "✓" ? ", in this crate" : mark(c.id) ? ", some in this crate" : ""}`}>
          <span style={{ width: 14, display: "inline-block" }} aria-hidden="true">{mark(c.id)}</span>
          <span>{c.name}</span>
        </button>
      ))}
      {shown.length === 0 && !creating && <div className="label">No crates yet</div>}
      {error && !creating && <div className="label error" role="alert">{error}</div>}
      <hr />
      {creating ? (
        <form onSubmit={createAndAdd}>
          <input autoFocus placeholder="New crate name" maxLength={CRATE_NAME_MAX} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }} />
          {error && <div className="label error" role="alert">{error}</div>}
        </form>
      ) : (
        <button role="menuitem" onClick={() => setCreating(true)}><span style={{ width: 14, display: "inline-block" }}>+</span><span>New crate…</span></button>
      )}
    </>
  );
}
