import { useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useAlbums, useArtists, useTracks } from "../api/queries";
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

function Albums() {
  const [sort, setSort] = useState("added");
  const { data, isLoading, error } = useAlbums(sort);
  if (error) return <div className="error">{String(error)}</div>;
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length) return <div className="empty">Your library is empty. <Link to="/import" style={{ color: "var(--accent-strong)" }}>Import a Bandcamp link</Link> to get started.</div>;
  return (
    <>
      <div className="toolbar">
        <span className="muted">{data.length} albums</span>
        <span className="spacer" />
        <label className="muted">Sort</label>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="added">Recently added</option>
          <option value="artist">Artist</option>
          <option value="release">Release date</option>
          <option value="title">Title</option>
        </select>
      </div>
      <div className="grid">{data.map((a) => <AlbumCard key={a.id} album={a} />)}</div>
    </>
  );
}

function Artists() {
  const { data, isLoading } = useArtists();
  if (isLoading) return <div className="empty">Loading…</div>;
  if (!data?.length) return <div className="empty">No artists yet.</div>;
  return (
    <div className="artist-list">
      {data.map((a) => (
        <Link key={a.id} to={`/artist/${a.id}`}>
          <div>{a.name}</div>
          <div className="sub">{a.album_count} release{a.album_count === 1 ? "" : "s"}{a.location ? ` · ${a.location}` : ""}</div>
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
