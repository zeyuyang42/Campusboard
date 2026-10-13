import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Api } from "./client";
import type { Job } from "@bc/shared";

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
  search: (q: string) => ["search", q] as const,
};

export const useAlbums = (sort: string) => useQuery({ queryKey: keys.albums(sort), queryFn: () => Api.albums(sort) });
export const useAlbum = (id: number) => useQuery({ queryKey: keys.album(id), queryFn: () => Api.album(id), enabled: id > 0 });
export const useArtists = () => useQuery({ queryKey: keys.artists, queryFn: Api.artists });
export const useArtist = (id: number) => useQuery({ queryKey: keys.artist(id), queryFn: () => Api.artist(id), enabled: id > 0 });
export const useTracks = (q: string) => useQuery({ queryKey: keys.tracks(q), queryFn: () => Api.tracks(q) });
export const usePlaylists = () => useQuery({ queryKey: keys.playlists, queryFn: Api.playlists });
export const usePlaylist = (id: number) => useQuery({ queryKey: keys.playlist(id), queryFn: () => Api.playlist(id), enabled: id > 0 });
export const useSearch = (q: string) => useQuery({ queryKey: keys.search(q), queryFn: () => Api.search(q), enabled: q.trim().length >= 2, staleTime: 60_000 });

const isActive = (j?: Job) => !!j && (j.status === "queued" || j.status === "running");
export const useJobs = () =>
  useQuery({ queryKey: keys.jobs, queryFn: Api.jobs, refetchInterval: (q) => (q.state.data?.some(isActive) ? 1000 : false) });
export const useJob = (id: number | null) =>
  useQuery({ queryKey: keys.job(id ?? 0), queryFn: () => Api.job(id!), enabled: !!id, refetchInterval: (q) => (isActive(q.state.data) ? 1000 : false) });

/** Invalidate everything that an import or edit may have changed. */
export function useInvalidateLibrary() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["albums"] });
    void qc.invalidateQueries({ queryKey: ["album"] });
    void qc.invalidateQueries({ queryKey: ["artists"] });
    void qc.invalidateQueries({ queryKey: ["artist"] });
    void qc.invalidateQueries({ queryKey: ["tracks"] });
    void qc.invalidateQueries({ queryKey: ["search"] });
  };
}

export function useImport() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ url, force }: { url: string; force?: boolean }) => Api.import(url, force), onSuccess: () => qc.invalidateQueries({ queryKey: keys.jobs }) });
}

export function usePlaylistMutations() {
  const qc = useQueryClient();
  const inv = (id?: number) => {
    void qc.invalidateQueries({ queryKey: keys.playlists });
    if (id) void qc.invalidateQueries({ queryKey: keys.playlist(id) });
  };
  return {
    create: useMutation({ mutationFn: Api.createPlaylist, onSuccess: () => inv() }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: number; name: string }) => Api.renamePlaylist(id, name), onSuccess: (_d, v) => inv(v.id) }),
    remove: useMutation({ mutationFn: Api.deletePlaylist, onSuccess: () => inv() }),
    addTracks: useMutation({ mutationFn: ({ id, trackIds }: { id: number; trackIds: number[] }) => Api.addToPlaylist(id, trackIds), onSuccess: (_d, v) => inv(v.id) }),
    reorder: useMutation({ mutationFn: ({ id, ids }: { id: number; ids: number[] }) => Api.reorderPlaylist(id, ids), onSuccess: (_d, v) => inv(v.id) }),
    removeTrack: useMutation({ mutationFn: ({ id, ptid }: { id: number; ptid: number }) => Api.removeFromPlaylist(id, ptid), onSuccess: (_d, v) => inv(v.id) }),
  };
}

export function useAlbumMutations() {
  const inv = useInvalidateLibrary();
  return {
    remove: useMutation({ mutationFn: Api.deleteAlbum, onSuccess: inv }),
    refresh: useMutation({ mutationFn: Api.refreshAlbum, onSuccess: inv }),
  };
}
