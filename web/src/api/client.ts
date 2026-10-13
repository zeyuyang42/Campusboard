import type { Album, AlbumWithTracks, Artist, Job, PlayState, Playlist, PlaylistWithTracks, SearchResult, Track } from "@bc/shared";

export class ApiClientError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiClientError(e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}
const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) });

export const Api = {
  albums: (sort: string) => api<{ albums: Album[] }>(`/albums?sort=${sort}`).then((r) => r.albums),
  album: (id: number) => api<{ album: AlbumWithTracks }>(`/albums/${id}`).then((r) => r.album),
  deleteAlbum: (id: number) => api<{ deleted: true }>(`/albums/${id}`, { method: "DELETE" }),
  refreshAlbum: (id: number) => post<{ album: AlbumWithTracks }>(`/albums/${id}/refresh`).then((r) => r.album),
  artists: () => api<{ artists: Artist[] }>("/artists").then((r) => r.artists),
  artist: (id: number) => api<{ artist: Artist & { albums: Album[] } }>(`/artists/${id}`).then((r) => r.artist),
  tracks: (q: string) => api<{ tracks: Track[] }>(`/tracks?q=${encodeURIComponent(q)}`).then((r) => r.tracks),
  import: (url: string, force = false) => post<{ job: Job }>("/import", { url, force }).then((r) => r.job),
  jobs: () => api<{ jobs: Job[] }>("/jobs").then((r) => r.jobs),
  job: (id: number) => api<{ job: Job }>(`/jobs/${id}`).then((r) => r.job),
  cancelJob: (id: number) => post<{ cancelled: boolean }>(`/jobs/${id}/cancel`),
  playlists: () => api<{ playlists: Playlist[] }>("/playlists").then((r) => r.playlists),
  playlist: (id: number) => api<{ playlist: PlaylistWithTracks }>(`/playlists/${id}`).then((r) => r.playlist),
  createPlaylist: (name: string) => post<{ playlist: Playlist }>("/playlists", { name }).then((r) => r.playlist),
  renamePlaylist: (id: number, name: string) => api<{ playlist: PlaylistWithTracks }>(`/playlists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deletePlaylist: (id: number) => api<{ deleted: true }>(`/playlists/${id}`, { method: "DELETE" }),
  addToPlaylist: (id: number, track_ids: number[]) => post<{ playlist: PlaylistWithTracks }>(`/playlists/${id}/tracks`, { track_ids }),
  reorderPlaylist: (id: number, playlist_track_ids: number[]) => api<{ playlist: PlaylistWithTracks }>(`/playlists/${id}/order`, { method: "PUT", body: JSON.stringify({ playlist_track_ids }) }),
  removeFromPlaylist: (id: number, ptid: number) => api<{ playlist: PlaylistWithTracks }>(`/playlists/${id}/tracks/${ptid}`, { method: "DELETE" }),
  search: (q: string) => api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
  playState: () => api<{ state: PlayState }>("/play-state").then((r) => r.state),
  savePlayState: (state: PlayState) => api<{ ok: true }>("/play-state", { method: "PUT", body: JSON.stringify(state) }),
};
