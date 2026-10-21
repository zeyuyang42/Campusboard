// Play or shuffle a whole set of tracks (the Library's bulk bar, smart playlists #84) through
// the player store's actions. The queue stops at MAX_QUEUE; each function returns a sentence
// to show when the cap cut the set short, else null.
import { plural } from "./format";
import type { repos, Track } from "@bc/core";
import { MAX_QUEUE, usePlayer } from "../player/store";

export const countStreamable = (t: Track[]) => t.reduce((n, x) => n + (x.streamable ? 1 : 0), 0);


/** Labels for the Library's Show filter and sorts, in ALBUM_SORTS order (a new sort in core needs one). */
export const SHOW_LABELS: Record<repos.AlbumFilter, string> = { all: "All", purchased: "Purchased", wishlist: "Wishlist", downloaded: "Downloaded", rated: "Rated" };
export const SORT_LABELS: Record<repos.AlbumSort, string> = { added: "Date added", played: "Recently played", plays: "Most played", artist: "Artist", title: "Album title", release: "Release date", rating: "Rating" };

export function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const cappedNote = (n: number, of: number, what: string) =>
  n < of ? `${what} ${n.toLocaleString()} of ${plural(of, "track")}: the queue holds at most ${MAX_QUEUE.toLocaleString()}.` : null;

/** Play the tracks in order. */
export function playAllTracks(t: Track[]): string | null {
  return cappedNote(usePlayer.getState().playTracks(t), countStreamable(t), "Queued the first");
}

/** Turn shuffle on and play from a random track; over the cap, queue a random sample instead of the first tracks. */
export function shuffleAllTracks(t: Track[]): string | null {
  const p = usePlayer.getState();
  if (!p.shuffle) p.toggleShuffle();
  const n = countStreamable(t);
  if (n > MAX_QUEUE) return cappedNote(p.playTracks(shuffled(t.filter((x) => x.streamable))), n, "Queued a random");
  // playTracks keeps its start track first and shuffles the rest; start somewhere random.
  const streamable = t.flatMap((x, i) => (x.streamable ? [i] : []));
  p.playTracks(t, streamable[Math.floor(Math.random() * streamable.length)] ?? 0);
  return null;
}
