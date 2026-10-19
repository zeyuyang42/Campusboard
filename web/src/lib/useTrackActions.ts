import { useNavigate } from "react-router-dom";
import { isRadioTrack, type Track } from "@bc/core";
import { usePlayer } from "../player/store";
import { useMenu, type MenuContent, type MenuItem } from "../ui/menu";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface TrackActionOptions {
  /** Shown as a danger item at the bottom, e.g. "Remove from playlist". */
  remove?: { label: string; onSelect: () => void };
  /** Hide "Go to album" when the list is already the album. */
  onAlbumPage?: boolean;
}

/** Builds the shared track menu used by rows, the queue and the selection bar. */
export function useTrackActions() {
  const nav = useNavigate();
  const player = usePlayer;
  return (tracks: Track[], opts: TrackActionOptions = {}): MenuContent => {
    const playable = tracks.filter((t) => t.streamable);
    const one = tracks.length === 1 ? tracks[0] : null;
    // A radio episode (in the queue) is not a library track: no playlist, its album is the Radio page.
    const library = tracks.filter((t) => !isRadioTrack(t));
    // Tracks that can't be streamed (not out yet, or never) get no play actions at all.
    const items: MenuItem[] = playable.length ? [
      { label: "Play", onSelect: () => player.getState().playTracks(playable) },
      { label: "Play next", onSelect: () => player.getState().enqueueNext(playable) },
      { label: "Add to queue", onSelect: () => player.getState().enqueueLast(playable) },
    ] : [];
    if (library.length) items.push(
      { label: library.length === 1 ? "Add to playlist…" : `Add ${library.length} tracks to playlist…`, onSelect: () => {
          const m = useMenu.getState();
          setTimeout(() => m.show({ x: m.x, y: m.y }, { playlistPicker: { trackIds: library.map((t) => t.id) } }), 0);
        } },
    );
    if (one && isRadioTrack(one)) items.push({ kind: "separator" }, { label: "Go to Radio", onSelect: () => nav("/radio") });
    else if (one && !opts.onAlbumPage) items.push({ kind: "separator" }, { label: "Go to album", onSelect: () => nav(`/album/${one.album_id}`) });
    if (one?.album_url) items.push({ label: "Open on Bandcamp", onSelect: () => void openUrl(one.album_url!).catch(() => window.open(one.album_url!, "_blank")) });
    if (opts.remove) items.push({ kind: "separator" }, { label: opts.remove.label, onSelect: opts.remove.onSelect, danger: true });
    return { items };
  };
}
