import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCore } from "./core";
import { repos, type Job, type PlayState } from "@bc/core";

export const keys = {
  albums: (sort: string, filter = "all", q = "") => ["albums", sort, filter, q] as const,
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
  account: ["account"] as const,
  libraryView: ["settings", "library_view"] as const,
  recentlyPlayed: ["history", "recent"] as const,
  playCount: ["history", "count"] as const,
  newReleases: ["releases", "list"] as const,
  newReleaseCount: ["releases", "count"] as const,
  releaseStatus: ["releases", "status"] as const,
  artistMuted: (id: number) => ["releases", "muted", id] as const,
  // Under "jobs" so every job update (an album arriving) refreshes it.
  pendingImports: ["jobs", "pending-imports"] as const,
};

const core = getCore;
/** Library albums; while the filter text changes, the previous result stays on screen. */
export const useAlbums = (sort: string, filter = "all", q = "") =>
  useQuery({ queryKey: keys.albums(sort, filter, q.trim()), queryFn: async () => (await core()).albums(sort as never, filter as never, q), placeholderData: keepPreviousData });

export type LibraryView = { sort: repos.AlbumSort; filter: repos.AlbumFilter };
const LIBRARY_VIEW_KEY = "library_view";
const DEFAULT_VIEW: LibraryView = { sort: "added", filter: "all" };
const FILTERS: readonly string[] = ["all", "purchased", "wishlist"] satisfies repos.AlbumFilter[];

function toLibraryView(v: unknown): LibraryView {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    sort: (repos.ALBUM_SORTS as readonly unknown[]).includes(o.sort) ? (o.sort as repos.AlbumSort) : DEFAULT_VIEW.sort,
    filter: FILTERS.includes(o.filter as string) ? (o.filter as repos.AlbumFilter) : DEFAULT_VIEW.filter,
  };
}

// library_view writes run one after another, so quick changes can't land out of order.
let libraryViewWrites: Promise<unknown> = Promise.resolve();

/** The Library's sort and Show choice, remembered in settings.key='library_view'. */
export function useLibraryView() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: keys.libraryView,
    // A settings read that fails falls back to the defaults rather than leaving the page loading.
    queryFn: async () => toLibraryView(await core().then((c) => c.getSetting(LIBRARY_VIEW_KEY)).catch(() => null)),
    staleTime: Infinity,
  });
  const set = (patch: Partial<LibraryView>) => {
    const next = { ...(qc.getQueryData<LibraryView>(keys.libraryView) ?? DEFAULT_VIEW), ...patch };
    qc.setQueryData(keys.libraryView, next);
    libraryViewWrites = libraryViewWrites.then(async () => (await core()).setSetting(LIBRARY_VIEW_KEY, next)).catch(() => undefined);
  };
  return { view: q.data, set };
}
/** Albums by latest play, for the Library's Recently played row. */
export const useRecentlyPlayed = (limit = 12) =>
  useQuery({ queryKey: [...keys.recentlyPlayed, limit], queryFn: async () => (await core()).recentlyPlayed(limit) });
/** How many plays the listening history holds. */
export const usePlayCount = () => useQuery({ queryKey: keys.playCount, queryFn: async () => (await core()).playCount() });

/** Forget all listening history, then refresh everything that shows it. */
export function useClearHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await core()).clearHistory(),
    onSuccess: () => { for (const k of ["history", "albums", "album", "tracks", "playlist"]) void qc.invalidateQueries({ queryKey: [k] }); },
  });
}
export const useAlbum = (id: number) => useQuery({ queryKey: keys.album(id), queryFn: async () => (await core()).album(id), enabled: id > 0 });
export const useArtists = () => useQuery({ queryKey: keys.artists, queryFn: async () => (await core()).artists() });
export const useArtist = (id: number) => useQuery({ queryKey: keys.artist(id), queryFn: async () => (await core()).artist(id), enabled: id > 0 });
export const useTracks = (q: string) => useQuery({ queryKey: keys.tracks(q), queryFn: async () => (await core()).tracks(q) });
export const usePlaylists = () => useQuery({ queryKey: keys.playlists, queryFn: async () => (await core()).playlists() });
export const usePlaylist = (id: number) => useQuery({ queryKey: keys.playlist(id), queryFn: async () => (await core()).playlist(id), enabled: id > 0 });
export const useSearch = (q: string) => useQuery({ queryKey: keys.search(q), queryFn: async () => (await core()).search(q), enabled: q.trim().length >= 2, staleTime: 60_000 });

const isActive = (j?: Job | null) => !!j && (j.status === "pending" || j.status === "queued" || j.status === "running");
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
    for (const k of ["albums", "album", "artists", "artist", "tracks", "search", "playlists", "playlist", "history", "releases"]) void qc.invalidateQueries({ queryKey: [k] });
  };
}

/** The Bandcamp account in Settings: username, whether a cookie is stored, the last sync. */
export const useAccount = () => useQuery({ queryKey: keys.account, queryFn: async () => (await core()).account() });

export function useAccountMutations() {
  const qc = useQueryClient();
  const inv = useInvalidateLibrary();
  const done = () => { void qc.invalidateQueries({ queryKey: keys.account }); };
  return {
    setUsername: useMutation({ mutationFn: async (username: string) => (await core()).setAccountUsername(username), onSuccess: () => { done(); inv(); void qc.invalidateQueries({ queryKey: keys.jobs }); } }),
    setCookie: useMutation({ mutationFn: async (cookie: string | null) => (await core()).setIdentityCookie(cookie), onSuccess: done }),
    clear: useMutation({ mutationFn: async () => (await core()).clearAccount(), onSuccess: () => { done(); inv(); void qc.invalidateQueries({ queryKey: keys.jobs }); } }),
    sync: useMutation({ mutationFn: async () => (await core()).syncCollection(), onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.jobs }); } }),
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

/** Releases library artists published after their first check (see core's ReleaseChecker). */
export const useNewReleases = () => useQuery({ queryKey: keys.newReleases, queryFn: async () => (await core()).newReleases() });
export const useNewReleaseCount = () => useQuery({ queryKey: keys.newReleaseCount, queryFn: async () => (await core()).newReleaseCount() });
/** The checker's setting and last check; polls while a Check now pass runs. */
export const useReleaseCheckStatus = () =>
  useQuery({ queryKey: keys.releaseStatus, queryFn: async () => (await core()).releaseCheckStatus(), refetchInterval: (q) => (q.state.data?.running ? 1000 : false) });
export const useArtistReleasesMuted = (id: number) =>
  useQuery({ queryKey: keys.artistMuted(id), queryFn: async () => (await core()).artistReleasesMuted(id), enabled: id > 0 });

export function useReleaseMutations() {
  const qc = useQueryClient();
  const inv = () => { void qc.invalidateQueries({ queryKey: ["releases"] }); };
  return {
    dismiss: useMutation({ mutationFn: async (ids: number[]) => (await core()).dismissReleases(ids), onSuccess: inv }),
    setEnabled: useMutation({ mutationFn: async (on: boolean) => (await core()).setReleaseChecksEnabled(on), onSuccess: inv }),
    checkNow: useMutation({ mutationFn: async () => (await core()).checkReleasesNow(), onMutate: () => { setTimeout(inv, 50); }, onSettled: inv }),
    setMuted: useMutation({ mutationFn: async ({ id, muted }: { id: number; muted: boolean }) => (await core()).setArtistReleasesMuted(id, muted), onSuccess: inv }),
  };
}

export async function cancelJob(id: number) { return (await core()).cancelJob(id); }
export async function loadPlayState() { return (await core()).playState(); }
export async function savePlayState(s: PlayState) { return (await core()).savePlayState(s); }

/** Playlist entries, plays and preferences from an imported library still waiting for their albums. */
export const usePendingImports = () => useQuery({ queryKey: keys.pendingImports, queryFn: async () => (await core()).pendingImports() });
