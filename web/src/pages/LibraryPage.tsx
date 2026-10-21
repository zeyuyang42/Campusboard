import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useParams, useSearchParams } from "react-router-dom";
import { repos } from "@bc/core";
import { useAlbums, useArtists, useLibraryView, useRecentlyPlayed, useTags, useTracks, type LibraryView } from "../api/queries";
import { libraryTagPath } from "../lib/navigation";
import { useUi } from "../ui/store";
import { friendlyError } from "../lib/errors";
import { formatPlays } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";
import { AlbumCard } from "../components/AlbumCard";
import { BulkBar } from "../components/BulkBar";
import { SHOW_LABELS, SORT_LABELS } from "../lib/bulkPlay";
import { TrackList, PlayPauseAll } from "../components/TrackList";
import { HistoryTab } from "../components/ListeningStats";

export function LibraryPage() {
  const { tab = "albums" } = useParams();
  return (
    <>
      <h1 className="page-title">Library</h1>
      <nav className="tabs">
        <NavLink to="/library/albums" className={tab === "albums" ? "active" : ""}>Albums</NavLink>
        <NavLink to="/library/artists" className={tab === "artists" ? "active" : ""}>Artists</NavLink>
        <NavLink to="/library/tracks" className={tab === "tracks" ? "active" : ""}>Tracks</NavLink>
        <NavLink to="/library/tags" className={tab === "tags" ? "active" : ""}>Tags</NavLink>
        <NavLink to="/library/history" className={tab === "history" ? "active" : ""}>History</NavLink>
      </nav>
      {tab === "albums" && <Albums />}
      {tab === "artists" && <Artists />}
      {tab === "tracks" && <Tracks />}
      {tab === "tags" && <LibraryTags />}
      {tab === "history" && <HistoryTab />}
    </>
  );
}

const FILTER_EMPTY: Record<string, string> = {
  purchased: "No purchases here yet. Add your Bandcamp username in Settings and sync your collection.",
  wishlist: "Nothing from your wishlist here yet. Add your Bandcamp username in Settings and sync your collection.",
  downloaded: "Nothing is available offline yet. Open an album and choose Make available offline.",
  rated: "No rated albums yet. Open an album and give it some stars.",
};
const FILTER_NAME: Record<string, string> = { purchased: "your purchases", wishlist: "your wishlist", downloaded: "your downloads", rated: "your rated albums" };


/** A rating as quiet text under a card, e.g. "★★★★"; nothing when unrated. */
const starsText = (r = 0) => (r > 0 ? "★".repeat(r) : "");

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

function AlbumGrid({ sort: savedSort, filter, set }: LibraryView & { set: (p: Partial<LibraryView>) => void }) {
  // "Show all" on the Recently played row switches the sort for this visit only; the saved
  // sort comes back next time, or as soon as a sort is picked from the menu.
  const [tempSort, setTempSort] = useState<repos.AlbumSort | null>(null);
  const sort = tempSort ?? savedSort;
  const q = useUi((s) => s.libraryQuery);
  const setQ = useUi((s) => s.setLibraryQuery);
  const term = useDebounced(q, 150).trim();
  // A tag (#71) lives in the address (?tag=), so album pages and the Tags tab can link to it.
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag")?.trim() ?? "";
  const clearTag = () => setParams((p) => { p.delete("tag"); return p; });
  const { data, isLoading, error } = useAlbums(sort, filter, term, tag);
  if (error) return <div className="notice error">Couldn't load your library. {friendlyError(error)}</div>;
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length && filter === "all" && !term && !q.trim() && !tag) return <div className="empty">Your library is empty. Paste a Bandcamp album, track or artist link on the Import page to get started.<br /><Link className="btn primary" to="/import">Go to Import</Link></div>;
  const n = data?.length ?? 0;
  // The Recently played row sits over the plain library view only: not while filtering, and
  // not when the grid itself is already ordered by listening.
  const shelf = filter === "all" && !term && !q.trim() && !tag && sort !== "played" && sort !== "plays";
  // Bulk actions only while the filter, a tag or Show narrows the list (the bar carries the count then).
  const bulk = (filter !== "all" || !!term || !!tag) && n > 0;
  return (
    <>
      <div className="toolbar">
        <FilterInput value={q} onChange={setQ} placeholder="Filter albums, artists, tracks" />
        {tag && (
          <span className="tag-filter">
            Tagged <span className="selectable">{tag}</span>
            <button className="icon-btn sm" onClick={clearTag} aria-label={`Clear tag ${tag}`} title="Clear tag">×</button>
          </span>
        )}
        {!bulk && <span className="muted">{n} album{n === 1 ? "" : "s"}</span>}
        <span className="spacer" />
        <label className="muted" htmlFor="album-filter">Show</label>
        <select id="album-filter" value={filter} onChange={(e) => set({ filter: e.target.value as repos.AlbumFilter })}>
          {(Object.keys(SHOW_LABELS) as repos.AlbumFilter[]).map((f) => <option key={f} value={f}>{SHOW_LABELS[f]}</option>)}
        </select>
        <label className="muted" htmlFor="album-sort">Sort</label>
        <select id="album-sort" value={sort} onChange={(e) => { setTempSort(null); set({ sort: e.target.value as repos.AlbumSort }); }}>
          {repos.ALBUM_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
        </select>
      </div>
      {bulk && <BulkBar albums={data!} sort={sort} filter={filter} q={term} tag={tag} />}
      {shelf && <RecentlyPlayed libraryCount={n} onShowAll={() => setTempSort("played")} />}
      {n ? <div className="grid">{data!.map((a) => <AlbumCard key={a.id} album={a} detail={sort === "plays" ? (a.play_count ? formatPlays(a.play_count) : "") : sort === "rating" ? starsText(a.rating) : undefined} />)}</div>
        : term || tag ? (
          <div className="empty">
            Nothing in {FILTER_NAME[filter] ?? "your library"}
            {tag && <> is tagged <span className="selectable">“{tag}”</span>{term ? " and" : ""}</>}
            {term && <> matches <span className="selectable">“{term}”</span></>}.<br />
            {term && <button className="btn" onClick={() => setQ("")}>Clear filter</button>}
            {tag && <>{term ? " " : ""}<button className="btn" onClick={clearTag}>Clear tag</button></>}
            {filter !== "all" && <> <button className="btn" onClick={() => set({ filter: "all" })}>Search all albums</button></>}
          </div>
        )
        : <div className="empty">{FILTER_EMPTY[filter]}{filter !== "downloaded" && filter !== "rated" && <><br /><Link className="btn" to="/settings#account">Open Settings</Link></>}</div>}
    </>
  );
}

// Must match .grid in styles.css: minmax(168px, 1fr) columns, 18px column gap.
const CARD_MIN = 168;
const CARD_GAP = 18;

/** How many grid columns fit in the element's width (at least 1). */
function useGridColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / (CARD_MIN + CARD_GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, cols] as const;
}

/**
 * The latest played albums as one row of the same grid, cut to what fits: no sideways
 * scrolling, and no hidden cards for keyboard focus to land on. Nothing until something has
 * been played, and nothing when the row would hold the whole library (it would only repeat
 * the grid below).
 */
function RecentlyPlayed({ libraryCount, onShowAll }: { libraryCount: number; onShowAll: () => void }) {
  const { data } = useRecentlyPlayed();
  const [ref, cols] = useGridColumns();
  const hidden = !data?.length || data.length >= libraryCount;
  return (
    <div ref={ref}>
      {!hidden && (
        <section className="shelf" aria-labelledby="recently-played">
          <div className="shelf-head">
            <h2 id="recently-played">Recently played</h2>
            <button className="btn ghost sm" onClick={onShowAll}>Show all</button>
          </div>
          <div className="grid">{data!.slice(0, cols).map((a) => <AlbumCard key={a.id} album={a} />)}</div>
        </section>
      )}
    </div>
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

/** Every tag in the library with its album count (#71); a tag opens the album grid narrowed to it. */
export function LibraryTags() {
  const { view, set } = useLibraryView();
  if (!view) return <div className="empty">Loading…</div>;
  return <TagList key={view.filter} filter={view.filter} showAll={() => set({ filter: "all" })} />;
}

function TagList({ filter, showAll }: { filter: repos.AlbumFilter; showAll: () => void }) {
  // Counted under the same Show choice as the album grid, so a tag's number is what it opens.
  const { data, isLoading, error } = useTags(filter);
  const setQ = useUi((s) => s.setLibraryQuery);
  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="notice error">Couldn't load your tags. {friendlyError(error)}</div>;
  const scope = filter !== "all" && (
    <p className="muted tag-scope">
      Counting albums in {FILTER_NAME[filter]}. <button className="btn ghost sm" onClick={showAll}>Count all albums</button>
    </p>
  );
  if (!data?.length) {
    return filter === "all"
      ? <div className="empty">No tags yet. Albums bring their Bandcamp tags with them when you import them.</div>
      : <>{scope}<div className="empty">No tags in {FILTER_NAME[filter]}.</div></>;
  }
  return (
    <>
    {scope}
    <ul className="tag-list">
      {data.map((t) => (
        <li key={t.tag}>
          <Link to={libraryTagPath(t.tag)} onClick={() => setQ("")}>
            <span className="name">{t.tag}</span>
            <span className="muted" aria-label={`${t.album_count} album${t.album_count === 1 ? "" : "s"}`}>{t.album_count}</span>
          </Link>
        </li>
      ))}
    </ul>
    </>
  );
}

function Tracks() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useTracks(useDebounced(q, 150).trim());
  return (
    <>
      <div className="toolbar">
        <FilterInput value={q} onChange={setQ} placeholder="Filter tracks, albums, artists" />
        {data && data.length > 0 && <PlayPauseAll tracks={data} />}
        <span className="spacer" />
        <span className="muted">{data?.length ?? 0} track{data?.length === 1 ? "" : "s"}{!q && data?.length === 500 ? " (showing latest 500)" : ""}</span>
      </div>
      {isLoading ? <div className="empty">Loading…</div> : data?.length ? <TrackList tracks={data} showAlbum /> : <div className="empty">No tracks.</div>}
    </>
  );
}
