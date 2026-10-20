import { Link, useNavigate } from "react-router-dom";
import { usePlaylistSummaries, usePlaylistMutations } from "../api/queries";
import { PlaylistCover } from "../components/PlaylistCover";
import { SmartRuleEditor } from "../components/SmartRuleEditor";
import { useState } from "react";
import { normalizePlaylistName, PLAYLIST_NAME_MAX } from "@bc/core";
import { friendlyError } from "../lib/errors";

export function PlaylistsPage() {
  const { data, isLoading } = usePlaylistSummaries();
  const { create, createSmart } = usePlaylistMutations();
  const nav = useNavigate();
  const [creating, setCreating] = useState<"plain" | "smart" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clean = normalizePlaylistName(name);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clean) return;
    try {
      const p = await create.mutateAsync(clean);
      nav(`/playlists/${p.id}`);
    } catch (err) {
      setError(friendlyError(err, "Couldn't create the playlist."));
    }
  };
  return (
    <>
      <h1 className="page-title">Playlists <span className="actions">{!creating && (
        <>
          <button className="btn" onClick={() => setCreating("smart")}>New smart playlist</button>
          <button className="btn primary" onClick={() => setCreating("plain")}>New playlist</button>
        </>
      )}</span></h1>
      {creating === "plain" && (
        <form className="inline-edit" onSubmit={submit} style={{ marginBottom: 18 }}>
          <input autoFocus placeholder="Playlist name" maxLength={PLAYLIST_NAME_MAX} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === "Escape") setCreating(null); }} />
          <button className="btn primary" type="submit" disabled={!clean || create.isPending}>Create</button>
          <button className="btn" type="button" onClick={() => { setCreating(null); setError(null); }}>Cancel</button>
          {error && <span className="error" role="alert">{error}</span>}
        </form>
      )}
      {creating === "smart" && (
        <SmartRuleEditor
          rule={null}
          name=""
          saveLabel="Create"
          onCancel={() => setCreating(null)}
          onSave={async (rule, smartName) => {
            const p = await createSmart.mutateAsync({ name: smartName!, rule });
            nav(`/playlists/${p.id}`);
          }}
        />
      )}
      {isLoading ? <div className="empty">Loading…</div> : !data?.length ? <div className="empty">No playlists yet. Select tracks and choose Add to playlist, or create one here. A smart playlist fills itself from a rule, such as rated 4 stars or more and tagged ambient.</div> : (
        <div className="pl-list">
          {data.map((p) => (
            <Link key={p.id} to={`/playlists/${p.id}`}>
              <PlaylistCover artIds={p.art_ids} />
              <div style={{ minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div className="sub"><span>{p.track_count} track{p.track_count === 1 ? "" : "s"}</span>{p.smart && <span className="smart-mark">Smart</span>}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
