import { useRef, useState } from "react";
import type { Album, repos, Track } from "@bc/core";
import { getCore } from "../api/core";
import { useArchiveMutations } from "../api/queries";
import { MAX_QUEUE, usePlayer } from "../player/store";
import { useMenu } from "../ui/menu";
import { friendlyError } from "../lib/errors";
import { ConfirmButton } from "./ConfirmButton";
import { PlayIcon, ShuffleIcon } from "./Icons";
import { cappedNote, countStreamable, playAllTracks, shuffleAllTracks } from "../lib/bulkPlay";
import { plural } from "../lib/format";

/** Above this many tracks, a bulk action asks first (inline, with ConfirmButton). */
export const BULK_CONFIRM_TRACKS = 500;

/**
 * Play, shuffle, queue, add to a playlist, put in a crate or archive every album the filtered
 * Library grid shows, in its sort order. The tracks are read from the library only when an
 * action runs, and stream URLs stay lazy: the player fetches each one when its track loads,
 * as for any queue. Crate and archive actions (#126) work on the albums themselves.
 */
export function BulkBar({ albums, sort, filter, q, tag = "", crate = 0 }: { albums: Album[]; sort: repos.AlbumSort; filter: repos.AlbumFilter; q: string; tag?: string; crate?: number }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { setArchivedMany } = useArchiveMutations();
  const total = albums.reduce((s, a) => s + (a.track_count ?? 0), 0);
  const playable = albums.reduce((s, a) => s + (a.streamable_count ?? 0), 0);

  /** `act` may return a sentence to show (when the queue cap cut the set short). */
  const run = async (act: (tracks: Track[]) => string | null | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(act(await (await getCore()).albumTracks(sort, filter, q, tag, crate > 0 ? { crate } : {})) ?? null);
    } catch (e) {
      setError(friendlyError(e, "Couldn't read these albums' tracks."));
    } finally {
      setBusy(false);
    }
  };
  const playAll = () => run(playAllTracks);
  // Over the cap, shuffle queues a random sample rather than the first albums in sort order.
  const shuffleAll = () => run(shuffleAllTracks);
  const queueAll = () => run((t) => {
    const n = countStreamable(t);
    const added = usePlayer.getState().enqueueLast(t);
    if (n && !added) return `The queue is full (${MAX_QUEUE.toLocaleString()} tracks).`;
    return cappedNote(added, n, "Added");
  });
  const addToPlaylist = () => run((t) => {
    // Anchored on the button's slot: after a confirm the button itself has been re-rendered.
    const at = anchor.current?.querySelector<HTMLElement>("[data-bulk-playlist]");
    if (at && t.length) useMenu.getState().show(at, { playlistPicker: { trackIds: t.map((x) => x.id) } });
  });
  const addToCrate = () => {
    const at = anchor.current?.querySelector<HTMLElement>("[data-bulk-crate]");
    if (at && albums.length) useMenu.getState().show(at, { cratePicker: { albumIds: albums.map((a) => a.id) } });
  };
  // Under Show → Archived every album shown is archived, so the action is the way back. No
  // note on success: the albums leave the grid, and the bar with them.
  const unarchive = filter === "archived";
  const archiveAll = async () => {
    setError(null);
    setNote(null);
    try {
      await setArchivedMany.mutateAsync({ ids: albums.map((a) => a.id), archived: !unarchive });
    } catch (e) {
      setError(friendlyError(e, unarchive ? "Couldn't unarchive these albums." : "Couldn't archive these albums."));
    }
  };

  const big = (n: number) => n > BULK_CONFIRM_TRACKS;
  const action = (label: React.ReactNode, n: number, verb: string, onRun: () => void) =>
    big(n)
      ? <ConfirmButton label={label} className="btn sm" confirmClassName="btn sm primary" disabled={busy || !n} question={`${verb} ${plural(n, "track")}?`} confirmLabel={verb} onConfirm={onRun} />
      : <button className="btn sm" disabled={busy || !n} onClick={onRun}>{label}</button>;

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Filtered albums" ref={anchor}>
      <span className="bulk-count">{plural(albums.length, "album")}, {plural(total, "track")}</span>
      {action(<><PlayIcon size={14} /> Play all</>, playable, "Play", playAll)}
      {action(<><ShuffleIcon /> Shuffle all</>, playable, "Shuffle", shuffleAll)}
      {action("Add to queue", playable, "Queue", queueAll)}
      <span data-bulk-playlist>{action("Add to playlist", total, "Add", addToPlaylist)}</span>
      <span data-bulk-crate><button className="btn sm" disabled={busy || !albums.length} onClick={addToCrate}>Add to crate</button></span>
      <ConfirmButton
        label={unarchive ? "Unarchive all" : "Archive all"} className="btn sm" confirmClassName="btn sm primary" disabled={busy || setArchivedMany.isPending || !albums.length}
        question={`${unarchive ? "Unarchive" : "Archive"} ${plural(albums.length, "album")}?`} confirmLabel={unarchive ? "Unarchive" : "Archive"} onConfirm={() => { void archiveAll(); }}
      />
      {error && <span className="error" role="alert">{error}</span>}
      {note && !error && <span className="muted" role="status">{note}</span>}
    </div>
  );
}
