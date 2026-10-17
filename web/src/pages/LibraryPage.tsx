import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useAlbums, useArtists, useTracks } from "../api/queries";
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

function Albums() {
  const [sort, setSort] = useState("added");
  const [filter, setFilter] = useState("all");
  const { data, isLoading, error } = useAlbums(sort, filter);
  if (error) return <div className="notice error">Couldn't load your library. {friendlyError(error)}</div>;
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length && filter === "all") return <div className="empty">Your library is empty. Paste a Bandcamp album, track or artist link on the Import page to get started.<br /><Link className="btn primary" to="/import">Go to Import</Link></div>;
  return (
    <>
      <div className="toolbar">
        <span className="muted">{data?.length ?? 0} albums</span>
        <span className="spacer" />
        <label className="muted" htmlFor="album-filter">Show</label>
        <select id="album-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="purchased">Purchased</option>
          <option value="wishlist">Wishlist</option>
        </select>
        <label className="muted">Sort</label>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="added">Recently added</option>
          <option value="artist">Artist</option>
          <option value="release">Release date</option>
          <option value="title">Title</option>
        </select>
      </div>
      {data?.length ? <div className="grid">{data.map((a) => <AlbumCard key={a.id} album={a} />)}</div> : <div className="empty">{FILTER_EMPTY[filter]}<br /><Link className="btn" to="/settings#account">Open Settings</Link></div>}
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
        <input placeholder="Filter tracks, albums, artists…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} />
        {data && data.length > 0 && <PlayPauseAll tracks={data} />}
        <span className="spacer" />
        <span className="muted">{data?.length ?? 0} tracks{!q && data?.length === 500 ? " (showing latest 500)" : ""}</span>
      </div>
      {isLoading ? <div className="empty">Loading…</div> : data?.length ? <TrackList tracks={data} showAlbum /> : <div className="empty">No tracks.</div>}
    </>
  );
}
