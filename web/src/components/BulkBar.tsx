import { useRef, useState } from "react";
import type { Album, repos, Track } from "@bc/core";
import { getCore } from "../api/core";
import { MAX_QUEUE, usePlayer } from "../player/store";
import { useMenu } from "../ui/menu";
import { friendlyError } from "../lib/errors";
import { ConfirmButton } from "./ConfirmButton";
import { PlayIcon, ShuffleIcon } from "./Icons";

/** Above this many tracks, a bulk action asks first (inline, with ConfirmButton). */
export const BULK_CONFIRM_TRACKS = 500;

const countStreamable = (t: Track[]) => t.reduce((n, x) => n + (x.streamable ? 1 : 0), 0);

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/**
 * Play, shuffle, queue or add to a playlist every album the filtered Library grid shows, in
 * its sort order. The tracks are read from the library only when an action runs, and stream
 * URLs stay lazy: the player fetches each one when its track loads, as for any queue.
 */
export function BulkBar({ albums, sort, filter, q }: { albums: Album[]; sort: repos.AlbumSort; filter: repos.AlbumFilter; q: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = albums.reduce((s, a) => s + (a.track_count ?? 0), 0);
  const playable = albums.reduce((s, a) => s + (a.streamable_count ?? 0), 0);

  /** `act` may return a sentence to show (when the queue cap cut the set short). */
  const run = async (act: (tracks: Track[]) => string | null | void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(act(await (await getCore()).albumTracks(sort, filter, q)) ?? null);
    } catch (e) {
      setError(friendlyError(e, "Couldn't read these albums' tracks."));
    } finally {
      setBusy(false);
    }
  };
  const { playTracks, enqueueLast } = usePlayer.getState();
  const capped = (n: number, of: number, what: string) =>
    n < of ? `${what} ${n.toLocaleString()} of ${plural(of, "track")}: the queue holds at most ${MAX_QUEUE.toLocaleString()}.` : null;
  const playAll = () => run((t) => capped(playTracks(t), countStreamable(t), "Queued the first"));
  const shuffleAll = () => run((t) => {
    const p = usePlayer.getState();
    if (!p.shuffle) p.toggleShuffle();
    const n = countStreamable(t);
    // Over the cap, queue a random sample rather than the first albums in sort order.
    if (n > MAX_QUEUE) return capped(playTracks(shuffled(t.filter((x) => x.streamable))), n, "Queued a random");
    // playTracks keeps its start track first and shuffles the rest; start somewhere random.
    const streamable = t.flatMap((x, i) => (x.streamable ? [i] : []));
    playTracks(t, streamable[Math.floor(Math.random() * streamable.length)] ?? 0);
    return null;
  });
  const queueAll = () => run((t) => {
    const n = countStreamable(t);
    const added = enqueueLast(t);
    if (n && !added) return `The queue is full (${MAX_QUEUE.toLocaleString()} tracks).`;
    return capped(added, n, "Added");
  });
  const addToPlaylist = () => run((t) => {
    // Anchored on the button's slot: after a confirm the button itself has been re-rendered.
    const at = anchor.current?.querySelector<HTMLElement>("[data-bulk-playlist]");
    if (at && t.length) useMenu.getState().show(at, { playlistPicker: { trackIds: t.map((x) => x.id) } });
  });

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
      {error && <span className="error" role="alert">{error}</span>}
      {note && !error && <span className="muted" role="status">{note}</span>}
    </div>
  );
}
