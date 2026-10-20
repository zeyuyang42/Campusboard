import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getCore } from "../api/core";
import { useArtists, usePlaylists } from "../api/queries";
import { usePalette } from "../ui/palette";
import { navigateTo } from "../lib/navigation";
import { filterActions, matches, PALETTE_ACTIONS } from "../lib/paletteActions";

/** Library results per group; the palette is for jumping, not browsing. */
export const PALETTE_GROUP_MAX = 6;
/** Debounce for the library query (the same #17 search the Library filter uses). */
export const PALETTE_DEBOUNCE_MS = 150;

interface Item {
  key: string;
  group: "Albums" | "Artists" | "Playlists" | "Actions";
  label: string;
  detail?: string;
  navigates: boolean;
  run: (query: string) => void;
}

/** A DOM id for a result row (keys hold ":" and ids of any kind). */
const optionId = (key: string) => `palette-option-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** ⌘K (View → Command Palette): one input that jumps to an album, artist or playlist, or runs an action. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  return open ? <Palette /> : null;
}

function Palette() {
  const hide = usePalette((s) => s.hide);
  const [q, setQ] = useState("");
  const term = useDebounced(q, PALETTE_DEBOUNCE_MS).trim();
  const albums = useQuery({
    queryKey: ["albums", "palette", term],
    queryFn: async () => (await getCore()).albums("title", "all", term, "", { limit: PALETTE_GROUP_MAX }),
    enabled: term.length > 0,
    // The previous term's albums stay until the new ones land, so the list doesn't flicker.
    placeholderData: keepPreviousData,
  });
  const artists = useArtists();
  const playlists = usePlaylists();

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (term) {
      for (const a of (albums.data ?? []).slice(0, PALETTE_GROUP_MAX)) {
        out.push({ key: `album:${a.id}`, group: "Albums", label: a.title, detail: a.artist_name, navigates: true, run: () => navigateTo(`/album/${a.id}`) });
      }
      for (const a of (artists.data ?? []).filter((x) => matches(x.name, term)).slice(0, PALETTE_GROUP_MAX)) {
        out.push({ key: `artist:${a.id}`, group: "Artists", label: a.name, navigates: true, run: () => navigateTo(`/artist/${a.id}`) });
      }
      for (const p of (playlists.data ?? []).filter((x) => matches(x.name, term)).slice(0, PALETTE_GROUP_MAX)) {
        out.push({ key: `playlist:${p.id}`, group: "Playlists", label: p.name, navigates: true, run: () => navigateTo(`/playlists/${p.id}`) });
      }
    }
    // Actions match the live text, so they answer before the library does.
    const actions = filterActions(q);
    for (const a of actions) out.push({ key: `action:${a.id}`, group: "Actions", label: a.label, navigates: !!a.navigates, run: a.run });
    // Any text can also go to Bandcamp's own search, last, so the palette never ends empty.
    const text = q.trim();
    const search = PALETTE_ACTIONS.find((a) => a.id === "search-bandcamp");
    if (text && search && !actions.includes(search)) {
      out.push({ key: "action:search-bandcamp", group: "Actions", label: `Search Bandcamp for “${text}”`, navigates: true, run: search.run });
    }
    return out;
  }, [term, q, albums.data, artists.data, playlists.data]);

  // The highlighted row is remembered by key, so results that arrive later (albums after the
  // debounce) don't move it. No key yet means the first row.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeIndex = items.length ? Math.max(0, items.findIndex((x) => x.key === activeKey)) : -1;
  const current = activeIndex >= 0 ? items[activeIndex] : undefined;
  useEffect(() => {
    if (current) document.getElementById(optionId(current.key))?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  // Library results for the text typed so far are still on their way (debounce or query).
  const pending = q.trim() !== term || (term.length > 0 && albums.isFetching);
  // Enter pressed while they were: it runs once they land, on the row highlighted then.
  const [enterQueued, setEnterQueued] = useState(false);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    // A result that opens a page leaves focus there; an action returns it to where it was.
    hide(!item.navigates);
    item.run(q);
  };
  useEffect(() => {
    if (enterQueued && !pending) {
      setEnterQueued(false);
      choose(current);
    }
  });

  const move = (to: number) => { setEnterQueued(false); setActiveKey(items[(to + items.length) % items.length].key); };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = items.length;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); if (n) move(activeIndex + 1); break;
      case "ArrowUp": e.preventDefault(); if (n) move(activeIndex - 1); break;
      case "Home": if (n) { e.preventDefault(); move(0); } break;
      case "End": if (n) { e.preventDefault(); move(n - 1); } break;
      case "Enter": e.preventDefault(); if (pending) setEnterQueued(true); else choose(current); break;
      case "Escape": e.preventDefault(); hide(); break;
      // The input is the palette's only stop: Tab would leave it behind an open panel.
      case "Tab": e.preventDefault(); break;
      default: return;
    }
    // Nothing the palette handled reaches the app's own key handling.
    e.stopPropagation();
  };

  const groups = (["Albums", "Artists", "Playlists", "Actions"] as const).map((g) => ({ g, rows: items.filter((x) => x.group === g) })).filter((x) => x.rows.length);
  return (
    <div className="palette-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); hide(); } }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          data-palette-input autoFocus type="text" className="palette-input" spellCheck={false} autoComplete="off"
          placeholder="Jump to an album, artist, playlist or action"
          role="combobox" aria-expanded={items.length > 0} aria-controls="palette-list" aria-autocomplete="list"
          aria-label="Find an album, artist, playlist or action"
          aria-activedescendant={current ? optionId(current.key) : undefined}
          value={q} onChange={(e) => { setQ(e.target.value); setActiveKey(null); setEnterQueued(false); }} onKeyDown={onKeyDown}
        />
        <div id="palette-list" role="listbox" aria-label="Results" className="palette-list">
          {groups.map(({ g, rows }) => (
            <div role="group" aria-labelledby={`palette-group-${g}`} key={g}>
              <div id={`palette-group-${g}`} className="palette-group">{g}</div>
              {rows.map((it) => {
                return (
                  <div
                    key={it.key} id={optionId(it.key)} role="option" aria-selected={it === current}
                    className={`palette-option${it === current ? " active" : ""}`}
                    onMouseMove={() => { if (it !== current) setActiveKey(it.key); }}
                    // Keep focus in the input; the click chooses.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(it)}
                  >
                    <span className="palette-label">{it.label}</span>
                    {it.detail && <span className="palette-detail">{it.detail}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {/* A live region outside the listbox: only options belong inside it. */}
        <div role="status" className={items.length ? "visually-hidden" : "palette-empty"}>
          {items.length ? "" : `Nothing matches “${q.trim()}”`}
        </div>
      </div>
    </div>
  );
}
