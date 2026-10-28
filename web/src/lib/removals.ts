// Removals that offer Undo (#93). Each one shows the single Undo note; its callbacks run
// after the page that started it may be gone, so they talk to core and the query cache directly.
import { getCore } from "../api/core";
import { invalidateQueries } from "../api/invalidate";
import { offerUndo } from "../ui/undo";

const LIBRARY = ["albums", "album", "artists", "artist", "tracks", "search", "playlists", "playlist", "history", "releases", "crates"];
const PLAYLISTS = ["playlists", "playlist"];
// The same prefixes as queries.ts' CRATE_KEYS and ARCHIVE_KEYS (#126).
const CRATES = ["crates", "albums"];
const ARCHIVE = ["albums", "album", "history"];

/** Archive an album (#126): it leaves the Albums tab at once; Undo brings it back. */
export async function archiveAlbumWithUndo(album: { id: number; title: string }): Promise<boolean> {
  const core = await getCore();
  if (!(await core.setAlbumArchived(album.id, true))) return false;
  invalidateQueries(ARCHIVE);
  offerUndo({
    text: `Archived "${album.title}".`,
    undo: async () => { await core.setAlbumArchived(album.id, false); invalidateQueries(ARCHIVE); },
  });
  return true;
}

/** Delete a crate (#126); Undo brings it back with its albums, under its old id when free. */
export async function deleteCrateWithUndo(crate: { id: number; name: string }): Promise<boolean> {
  const core = await getCore();
  const snap = await core.deleteCrateWithUndo(crate.id);
  invalidateQueries(CRATES);
  if (!snap) return false;
  offerUndo({
    text: `Deleted "${crate.name}".`,
    undo: async () => { await core.restoreCrate(snap); invalidateQueries(CRATES); },
  });
  return true;
}

/**
 * Remove an album from the library. It disappears at once; the real delete (rows, offline
 * files, notes, plays, resume points) runs when the note goes, or when the window closes,
 * or at the next start if the app quits first. Playback of it carries on meanwhile.
 */
export async function removeAlbumWithUndo(album: { id: number; title: string }): Promise<boolean> {
  const core = await getCore();
  if (!(await core.removeAlbumLater(album.id))) return false;
  invalidateQueries(LIBRARY);
  offerUndo({
    text: `Removed "${album.title}".`,
    undo: async () => { await core.undoRemoveAlbum(album.id); invalidateQueries(LIBRARY); },
    finish: async () => { await core.finishAlbumRemovals([album.id]); invalidateQueries(LIBRARY); },
  });
  return true;
}

/** Take one entry out of a playlist; Undo puts it back at its place. */
export async function removePlaylistTrackWithUndo(playlistId: number, entry: { playlist_track_id: number; title: string }): Promise<boolean> {
  const core = await getCore();
  const snap = await core.removeFromPlaylistWithUndo(playlistId, [entry.playlist_track_id]);
  invalidateQueries(PLAYLISTS);
  if (!snap) return false;
  offerUndo({
    text: `Removed "${entry.title}" from the playlist.`,
    undo: async () => { await core.restorePlaylistTracks(snap); invalidateQueries(PLAYLISTS); },
  });
  return true;
}

/** Delete a playlist (a smart one keeps its rule); Undo brings it back, under its old id when free. */
export async function deletePlaylistWithUndo(playlist: { id: number; name: string }): Promise<boolean> {
  const core = await getCore();
  const snap = await core.deletePlaylistWithUndo(playlist.id);
  invalidateQueries(PLAYLISTS);
  if (!snap) return false;
  offerUndo({
    text: `Deleted "${playlist.name}".`,
    undo: async () => { await core.restorePlaylist(snap); invalidateQueries(PLAYLISTS); },
  });
  return true;
}
