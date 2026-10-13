import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenu, type MenuItem } from "../ui/menu";
import { usePlaylists, usePlaylistMutations } from "../api/queries";
import { getCore } from "../api/core";

/** Renders the single app menu (context menu or playlist picker) with keyboard support. */
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
      {"items" in content ? <Items items={content.items} /> : <PlaylistPicker trackIds={content.playlistPicker.trackIds} />}
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
  const [containing, setContaining] = useState<Set<number>>(new Set());
  useEffect(() => { void getCore().then((c) => c.playlistsContaining(trackIds)).then(setContaining); }, [trackIds]);
  const shown = (playlists ?? []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  const add = async (id: number) => { close(); await addTracks.mutateAsync({ id, trackIds }); };
  const createAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const p = await create.mutateAsync(name.trim());
    await addTracks.mutateAsync({ id: p.id, trackIds });
    close();
  };
  const n = trackIds.length;
  return (
    <>
      <div className="label">Add {n === 1 ? "to playlist" : `${n} tracks to playlist`}</div>
      {(playlists?.length ?? 0) > 8 && <input placeholder="Filter playlists" value={filter} onChange={(e) => setFilter(e.target.value)} />}
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
          <input autoFocus placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }} />
        </form>
      ) : (
        <button role="menuitem" onClick={() => setCreating(true)}><span style={{ width: 14, display: "inline-block" }}>+</span><span>New playlist…</span></button>
      )}
    </>
  );
}
