import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCore } from "./core";
import type { Job, PlayState } from "@bc/core";

export const keys = {
  albums: (sort: string) => ["albums", sort] as const,
  album: (id: number) => ["album", id] as const,
  artists: ["artists"] as const,
  artist: (id: number) => ["artist", id] as const,
  tracks: (q: string) => ["tracks", q] as const,
  playlists: ["playlists"] as const,
  playlist: (id: number) => ["playlist", id] as const,
  jobs: ["jobs"] as const,
  job: (id: number) => ["job", id] as const,
  challenge: ["jobs", "challenge"] as const,
  search: (q: string) => ["search", q] as const,
};

const core = getCore;
export const useAlbums = (sort: string) => useQuery({ queryKey: keys.albums(sort), queryFn: async () => (await core()).albums(sort as never) });
export const useAlbum = (id: number) => useQuery({ queryKey: keys.album(id), queryFn: async () => (await core()).album(id), enabled: id > 0 });
export const useArtists = () => useQuery({ queryKey: keys.artists, queryFn: async () => (await core()).artists() });
export const useArtist = (id: number) => useQuery({ queryKey: keys.artist(id), queryFn: async () => (await core()).artist(id), enabled: id > 0 });
export const useTracks = (q: string) => useQuery({ queryKey: keys.tracks(q), queryFn: async () => (await core()).tracks(q) });
export const usePlaylists = () => useQuery({ queryKey: keys.playlists, queryFn: async () => (await core()).playlists() });
export const usePlaylist = (id: number) => useQuery({ queryKey: keys.playlist(id), queryFn: async () => (await core()).playlist(id), enabled: id > 0 });
export const useSearch = (q: string) => useQuery({ queryKey: keys.search(q), queryFn: async () => (await core()).search(q), enabled: q.trim().length >= 2, staleTime: 60_000 });

const isActive = (j?: Job | null) => !!j && (j.status === "queued" || j.status === "running");
export const useJobs = () =>
  useQuery({ queryKey: keys.jobs, queryFn: async () => (await core()).jobs(), refetchInterval: (q) => (q.state.data?.some(isActive) ? 1000 : false) });
export const useJob = (id: number | null) =>
  useQuery({ queryKey: keys.job(id ?? 0), queryFn: async () => (await core()).job(id!), enabled: !!id, refetchInterval: (q) => (isActive(q.state.data) ? 1000 : false) });
/** When Bandcamp requests resume after a bot challenge, or null. Keyed under "jobs" so job updates refresh it. */
export const useChallengeUntil = () =>
  useQuery({ queryKey: keys.challenge, queryFn: async () => (await core()).challengeUntil(), refetchInterval: (q) => (q.state.data ? 5000 : false) });

/** Invalidate everything that an import or edit may have changed. */
export function useInvalidateLibrary() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["albums", "album", "artists", "artist", "tracks", "search", "playlists", "playlist"]) void qc.invalidateQueries({ queryKey: [k] });
  };
}

export function useImport() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async ({ url, force }: { url: string; force?: boolean }) => (await core()).import({ url, force }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.jobs }) });
}

export function usePlaylistMutations() {
  const qc = useQueryClient();
  const inv = (id?: number) => {
    void qc.invalidateQueries({ queryKey: keys.playlists });
    if (id) void qc.invalidateQueries({ queryKey: keys.playlist(id) });
  };
  return {
    create: useMutation({ mutationFn: async (name: string) => (await core()).createPlaylist(name), onSuccess: () => inv() }),
    rename: useMutation({ mutationFn: async ({ id, name }: { id: number; name: string }) => (await core()).renamePlaylist(id, name), onSuccess: (_d, v) => inv(v.id) }),
    remove: useMutation({ mutationFn: async (id: number) => (await core()).deletePlaylist(id), onSuccess: () => inv() }),
    addTracks: useMutation({ mutationFn: async ({ id, trackIds }: { id: number; trackIds: number[] }) => (await core()).addToPlaylist(id, trackIds), onSuccess: (_d, v) => inv(v.id) }),
    reorder: useMutation({ mutationFn: async ({ id, ids }: { id: number; ids: number[] }) => (await core()).reorderPlaylist(id, ids), onSuccess: (_d, v) => inv(v.id) }),
    removeTrack: useMutation({ mutationFn: async ({ id, ptid }: { id: number; ptid: number }) => (await core()).removeFromPlaylist(id, ptid), onSuccess: (_d, v) => inv(v.id) }),
  };
}

export function useAlbumMutations() {
  const inv = useInvalidateLibrary();
  return {
    remove: useMutation({ mutationFn: async (id: number) => (await core()).deleteAlbum(id), onSuccess: inv }),
    refresh: useMutation({ mutationFn: async (id: number) => (await core()).refreshAlbum(id), onSuccess: inv }),
  };
}

export async function cancelJob(id: number) { return (await core()).cancelJob(id); }
export async function loadPlayState() { return (await core()).playState(); }
export async function savePlayState(s: PlayState) { return (await core()).savePlayState(s); }
