// Bandcamp Radio in the player (#44): an episode is one long queue entry; the tracklist entry
// under the playhead ("now featuring") is derived from the store's position, never stored.
import { radioEntryAt, type QueueTrack } from "@bc/core";
import { useRadioShow } from "../api/queries";
import { usePlayer } from "./store";

/** The episode behind a radio queue entry, and which of its featured tracks is playing now. */
export function useRadioNow(cur: QueueTrack | null) {
  const showId = cur?.radio?.show_id ?? null;
  const { data: show, isPending, error } = useRadioShow(showId);
  // Re-renders only when the featured entry changes, not on every position report.
  const index = usePlayer((s) => (show && s.queue[s.index]?.radio?.show_id === show.id ? radioEntryAt(show.tracks, s.position) : -1));
  return { show: showId ? show ?? null : null, index, entry: show && index >= 0 ? show.tracks[index] : null, isPending: !!showId && isPending, error };
}
