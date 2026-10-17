import { useEffect, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { repos } from "@bc/core";
import { useAlbums, useArtists, useLibraryView, useTracks, type LibraryView } from "../api/queries";
import { useUi } from "../ui/store";
import { friendlyError } from "../lib/errors";
import { AlbumCard } from "../components/AlbumCard";
import { TrackList, PlayPauseAll } from "../components/TrackList";

export function LibraryPage() {
  const { tab = "albums" } = useParams();
  return (
    <>
      <h1 className="page-title">Library</h1>
      <nav className="tabs">
        <NavLink to="/library/albums" className={tab === "albums" ? "active" : ""}>Albums</NavLink>
        <NavLink to="/library/artists" className={tab === "artists" ? "active" : ""}>Artists</NavLink>
        <NavLink to="/library/tracks" className={tab === "tracks" ? "active" : ""}>Tracks</NavLink>
      </nav>
      {tab === "albums" && <Albums />}
      {tab === "artists" && <Artists />}
      {tab === "tracks" && <Tracks />}
    </>
  );
}

const FILTER_EMPTY: Record<string, string> = {
  purchased: "No purchases here yet. Add your Bandcamp username in Settings and sync your collection.",
  wishlist: "Nothing from your wishlist here yet. Add your Bandcamp username in Settings and sync your collection.",
};
const FILTER_NAME: Record<string, string> = { purchased: "your purchases", wishlist: "your wishlist" };

// Offered in ALBUM_SORTS order; a new sort in core needs a label here.
const SORT_LABELS: Record<repos.AlbumSort, string> = { added: "Date added", artist: "Artist", title: "Album title", release: "Release date" };

/** `value`, but only after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** The filter field: `/` focuses it on the Library page, Esc clears it (or leaves it when empty). */
function FilterInput({ value, onChange, placeholder }: { value: string; onChange: (q: string) => void; placeholder: string }) {
  return (
    <input
      type="text" data-library-filter className="library-filter" placeholder={placeholder} aria-label={placeholder}
      value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (value) onChange(""); else e.currentTarget.blur();
      }}
    />
  );
}

function Albums() {
  const { view, set } = useLibraryView();
  if (!view) return <div className="empty">Loading…</div>;
  return <AlbumGrid sort={view.sort} filter={view.filter} set={set} />;
}

function AlbumGrid({ sort, filter, set }: LibraryView & { set: (p: Partial<LibraryView>) => void }) {
  const q = useUi((s) => s.libraryQuery);
  const setQ = useUi((s) => s.setLibraryQuery);
  const term = useDebounced(q, 150).trim();
  const { data, isLoading, error } = useAlbums(sort, filter, term);
  if (error) return <div className="notice error">Couldn't load your library. {friendlyError(error)}</div>;
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length && filter === "all" && !term && !q.trim()) return <div className="empty">Your library is empty. Paste a Bandcamp album, track or artist link on the Import page to get started.<br /><Link className="btn primary" to="/import">Go to Import</Link></div>;
  const n = data?.length ?? 0;
  return (
    <>
      <div className="toolbar">
        <FilterInput value={q} onChange={setQ} placeholder="Filter albums, artists, tracks" />
        <span className="muted">{n} album{n === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <label className="muted" htmlFor="album-filter">Show</label>
        <select id="album-filter" value={filter} onChange={(e) => set({ filter: e.target.value as repos.AlbumFilter })}>
          <option value="all">All</option>
          <option value="purchased">Purchased</option>
          <option value="wishlist">Wishlist</option>
        </select>
        <label className="muted" htmlFor="album-sort">Sort</label>
        <select id="album-sort" value={sort} onChange={(e) => set({ sort: e.target.value as repos.AlbumSort })}>
          {repos.ALBUM_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
        </select>
      </div>
      {n ? <div className="grid">{data!.map((a) => <AlbumCard key={a.id} album={a} />)}</div>
        : term ? (
          <div className="empty">
            Nothing in {FILTER_NAME[filter] ?? "your library"} matches <span className="selectable">“{term}”</span>.<br />
            <button className="btn" onClick={() => setQ("")}>Clear filter</button>
            {filter !== "all" && <> <button className="btn" onClick={() => set({ filter: "all" })}>Search all albums</button></>}
          </div>
        )
        : <div className="empty">{FILTER_EMPTY[filter]}<br /><Link className="btn" to="/settings#account">Open Settings</Link></div>}
    </>
  );
}

function Artists() {
  const { data, isLoading } = useArtists();
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length) return <div className="empty">No artists yet. They appear here as you import albums.</div>;
  return (
    <div className="artist-list">
      {data.map((a) => (
        <Link key={a.id} to={`/artist/${a.id}`}>
          <div><div>{a.name}</div><div className="sub"><span>{a.album_count} release{a.album_count === 1 ? "" : "s"}</span>{a.location && <span>{a.location}</span>}</div></div>
        </Link>
      ))}
    </div>
  );
}

function Tracks() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useTracks(q);
  return (
    <>
      <div className="toolbar">
        <FilterInput value={q} onChange={setQ} placeholder="Filter tracks, albums, artists" />
        {data && data.length > 0 && <PlayPauseAll tracks={data} />}
        <span className="spacer" />
        <span className="muted">{data?.length ?? 0} tracks{!q && data?.length === 500 ? " (showing latest 500)" : ""}</span>
      </div>
      {isLoading ? <div className="empty">Loading…</div> : data?.length ? <TrackList tracks={data} showAlbum /> : <div className="empty">No tracks.</div>}
    </>
  );
}
