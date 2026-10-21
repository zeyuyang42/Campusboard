import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCore } from "./core";
import { repos, type DiscoverPage, type DiscoverParams, type HistoryCursor, type Job, type PlayState, type StatsPeriod } from "@bc/core";

export const keys = {
  albums: (sort: string, filter = "all", q = "", tag = "") => ["albums", sort, filter, q, tag] as const,
  // Under "albums" so an import or a removal refreshes the counts.
  tags: (filter = "all") => ["albums", "tags", filter] as const,
  album: (id: number) => ["album", id] as const,
  // Under "album" so a refresh or an imported library (which invalidate "album") reload it.
  albumNote: (id: number) => ["album", id, "note"] as const,
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
  // Under "account" so a sync (any job update) refreshes it.
  collectionRefresh: ["account", "refresh"] as const,
  libraryView: ["settings", "library_view"] as const,
  recentlyPlayed: ["history", "recent"] as const,
  playCount: ["history", "count"] as const,
  // Under "history" (plays recorded, history cleared) and refreshed with the library (album removed).
  historyList: ["history", "list"] as const,
  historyStats: (period: StatsPeriod) => ["history", "stats", period] as const,
  newReleases: ["releases", "list"] as const,
  newReleaseCount: ["releases", "count"] as const,
  releaseStatus: ["releases", "status"] as const,
  artistMuted: (id: number) => ["releases", "muted", id] as const,
  // Under "jobs" so every job update (an album arriving) refreshes it.
  pendingImports: ["jobs", "pending-imports"] as const,
  radioShows: ["radio", "list"] as const,
  // Under "albums" so an import refreshes which featured releases are in the library.
  radioShow: (id: number) => ["albums", "radio-show", id] as const,
  offline: ["offline"] as const,
  // Not under "albums": an import must not refetch every loaded page (one POST each). A card
  // marks its own album from its import job instead.
  discover: (p: DiscoverParams) => ["discover", p.tags.join(","), p.slice, p.time, p.location] as const,
  discoverTags: (prefix: string) => ["discover", "tags", prefix] as const,
  discoverLocations: (q: string) => ["discover", "locations", q] as const,
};

const core = getCore;
/** Library albums; while the filter text changes, the previous result stays on screen. */
export const useAlbums = (sort: string, filter = "all", q = "", tag = "") =>
  useQuery({ queryKey: keys.albums(sort, filter, q.trim(), tag), queryFn: async () => (await core()).albums(sort as never, filter as never, q, tag), placeholderData: keepPreviousData });
/** The library's tags with album counts under the Show filter (#71), so they match the grid. */
export const useTags = (filter: repos.AlbumFilter = "all") => useQuery({ queryKey: keys.tags(filter), queryFn: async () => (await core()).tags(filter) });

export type LibraryView = { sort: repos.AlbumSort; filter: repos.AlbumFilter };
const LIBRARY_VIEW_KEY = "library_view";
const DEFAULT_VIEW: LibraryView = { sort: "added", filter: "all" };
const FILTERS: readonly string[] = ["all", "purchased", "wishlist", "downloaded", "rated"] satisfies repos.AlbumFilter[];

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

/** The History tab (#86): plays newest first, one page at a time. */
export const HISTORY_PAGE = 50;
export const usePlayHistory = () =>
  useInfiniteQuery({
    queryKey: keys.historyList,
    queryFn: async ({ pageParam }) => (await core()).history(pageParam, HISTORY_PAGE),
    initialPageParam: null as HistoryCursor | null,
    getNextPageParam: (last) => last.next,
  });

/** Listening stats for a period (#94); the previous period stays on screen while the next loads. */
export const useListeningStats = (period: StatsPeriod) =>
  useQuery({ queryKey: keys.historyStats(period), queryFn: async () => (await core()).listeningStats(period), placeholderData: keepPreviousData });

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
/** usePlaylists plus smart playlists' counts and covers (#84), evaluated per smart playlist: the Playlists page only. */
export const usePlaylistSummaries = () => useQuery({ queryKey: [...keys.playlists, "summaries"], queryFn: async () => (await core()).playlists({ summaries: true }) });
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

/** The background collection refresh: its setting and the last automatic run. */
export const useCollectionRefresh = () => useQuery({ queryKey: keys.collectionRefresh, queryFn: async () => (await core()).collectionRefreshStatus() });
export function useCollectionRefreshMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: async (on: boolean) => (await core()).setCollectionRefreshEnabled(on), onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.collectionRefresh }); } });
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
    addTracks: useMutation({ mutationFn: async ({ id, trackIds }: { id: number; trackIds: number[] }) => (await core()).addToPlaylist(id, trackIds), onSuccess: (_d, v) => inv(v.id) }),
    reorder: useMutation({ mutationFn: async ({ id, ids }: { id: number; ids: number[] }) => (await core()).reorderPlaylist(id, ids), onSuccess: (_d, v) => inv(v.id) }),
    /** A smart playlist (#84) from a name and a rule. */
    createSmart: useMutation({ mutationFn: async ({ name, rule }: { name: string; rule: repos.SmartRuleInput }) => (await core()).createSmartPlaylist(name, rule), onSuccess: () => inv() }),
    setRule: useMutation({ mutationFn: async ({ id, rule }: { id: number; rule: repos.SmartRuleInput }) => (await core()).setSmartRule(id, rule), onSuccess: (_d, v) => inv(v.id) }),
  };
}

/** How many tracks a smart playlist rule matches right now (#84); disabled while the rule is invalid. */
export const useSmartCount = (rule: repos.SmartRule | null) =>
  useQuery({ queryKey: ["smartCount", rule], queryFn: async () => (await core()).smartCount(rule), enabled: !!rule, placeholderData: keepPreviousData });

/** Your note and rating for an album (#73). */
export const useAlbumNote = (id: number) => useQuery({ queryKey: keys.albumNote(id), queryFn: async () => (await core()).albumNote(id), enabled: id > 0 });

// Rating and note writes of one album run one after another: the SQL plugin pools
// connections, so two quick upserts could otherwise commit out of order.
const noteWrites = new Map<number, Promise<unknown>>();
function serialWrite<T>(albumId: number, fn: () => Promise<T>): Promise<T> {
  const run = (noteWrites.get(albumId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  noteWrites.set(albumId, tail);
  void tail.then(() => { if (noteWrites.get(albumId) === tail) noteWrites.delete(albumId); });
  return run;
}

/**
 * Save a rating or a note. The cache takes the new value at once (also for the save made as
 * the page goes away), so the album page shows it on return before any refetch; it is read
 * back from the database once the write is done, or failed. The Library's Rating sort and
 * Rated filter follow a rating.
 */
export function useAlbumNoteWriter(id: number) {
  const qc = useQueryClient();
  const write = (patch: Partial<repos.AlbumNote>, fn: (c: Awaited<ReturnType<typeof core>>) => Promise<unknown>) => {
    qc.setQueryData<repos.AlbumNote | null>(keys.albumNote(id), (old) => ({ rating: 0, note: "", updated_at: "", ...(old ?? {}), ...patch }));
    return serialWrite(id, async () => fn(await core())).finally(() => { void qc.invalidateQueries({ queryKey: keys.albumNote(id) }); });
  };
  return {
    setRating: (rating: number) => write({ rating }, (c) => c.setAlbumRating(id, rating)).then(() => { void qc.invalidateQueries({ queryKey: ["albums"] }); }),
    setNote: (note: string) => write({ note }, (c) => c.setAlbumNote(id, note)),
  };
}

export function useAlbumMutations() {
  const inv = useInvalidateLibrary();
  return {
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

/** Offline copies (#2): totals and the size limit for Settings > Storage. */
export const useOfflineStats = () => useQuery({ queryKey: keys.offline, queryFn: async () => (await core()).offlineStats() });

export function useOfflineMutations() {
  const qc = useQueryClient();
  const inv = () => {
    for (const k of ["offline", "albums", "album", "tracks", "playlist", "jobs"]) void qc.invalidateQueries({ queryKey: [k] });
  };
  return {
    downloadAlbum: useMutation({ mutationFn: async (id: number) => (await core()).downloadAlbum(id), onSuccess: inv }),
    removeAlbum: useMutation({ mutationFn: async (id: number) => (await core()).removeAlbumDownloads(id), onSuccess: inv }),
    removeAll: useMutation({ mutationFn: async () => (await core()).removeAllDownloads(), onSuccess: inv }),
    setCap: useMutation({ mutationFn: async (mb: number | null) => (await core()).setOfflineCap(mb), onSuccess: inv }),
  };
}

export async function cancelJob(id: number) { return (await core()).cancelJob(id); }
export async function loadPlayState() { return (await core()).playState(); }
export async function savePlayState(s: PlayState) { return (await core()).savePlayState(s); }
export async function savePlayPosition(trackId: number | null, positionSec: number, index: number) { return (await core()).savePlayPosition(trackId, positionSec, index); }
/** One track's lyrics, read when Now playing shows them (queue entries don't carry them). */
export const useTrackLyrics = (id: number | null) =>
  useQuery({ queryKey: ["tracks", "lyrics", id], queryFn: async () => (await (await core()).tracksByIds([id!]))[0]?.lyrics ?? null, enabled: id != null, staleTime: Infinity });

/** The latest Bandcamp Radio episodes. Core caches the page for a day; this keeps it for the session. */
export const useRadioShows = () => useQuery({ queryKey: keys.radioShows, queryFn: async () => (await core()).radioShows(), staleTime: 60 * 60 * 1000 });
/** One episode's tracklist (core keeps it in memory after the first read, so refetches are free). */
export const useRadioShow = (id: number | null, load = true) =>
  useQuery({ queryKey: keys.radioShow(id ?? 0), queryFn: async () => (await core()).radioShow(id!), enabled: load && id != null && id > 0, staleTime: Infinity });

/** Playlist entries, plays and preferences from an imported library still waiting for their albums. */
export const usePendingImports = () => useQuery({ queryKey: keys.pendingImports, queryFn: async () => (await core()).pendingImports() });

/**
 * Bandcamp discover (#104), 60 releases a page; the next page only on fetchNextPage ("Show
 * more"). Never stale, so it is never refetched on its own (a remount would refetch every
 * loaded page); it is dropped gcTime (5 min) after the page leaves the screen.
 */
export const useDiscover = (p: DiscoverParams) =>
  useInfiniteQuery({
    queryKey: keys.discover(p),
    queryFn: async ({ pageParam }) => (await core()).discover(p, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    staleTime: Infinity,
    refetchOnReconnect: false,
    retry: false,
  });
/** Mark `url` as library album `albumId` in every cached discover page (after its import). No request. */
export function markDiscoverInLibrary(qc: ReturnType<typeof useQueryClient>, url: string, albumId: number) {
  qc.setQueriesData<{ pages: DiscoverPage[]; pageParams: unknown[] }>({ queryKey: ["discover"] }, (d) =>
    d && Array.isArray(d.pages)
      ? { ...d, pages: d.pages.map((p) => (p.items.some((i) => i.url === url) ? { ...p, items: p.items.map((i) => (i.url === url ? { ...i, album_id: albumId } : i)) } : p)) }
      : d);
}
/** Bandcamp's tag autocomplete for a (debounced) prefix of 2+ characters. */
export const useDiscoverTags = (prefix: string) =>
  useQuery({ queryKey: keys.discoverTags(prefix), queryFn: async () => (await core()).discoverTags(prefix), enabled: prefix.length >= 2, staleTime: 60 * 60_000, retry: false });
/** Bandcamp's place search for a (debounced) query of 3+ characters. */
export const useDiscoverLocations = (q: string) =>
  useQuery({ queryKey: keys.discoverLocations(q), queryFn: async () => (await core()).discoverLocations(q), enabled: q.length >= 3, staleTime: 60 * 60_000, retry: false });
