// Shared DTOs between server and web.
import type { SmartRule } from "./db/repos/smartPlaylists.js";

export type ItemType = "album" | "track";

export interface Artist {
  id: number;
  band_id: number;
  name: string;
  url: string;
  location: string | null;
  created_at: string;
  album_count?: number;
}

export interface Album {
  id: number;
  bandcamp_id: number;
  item_type: ItemType;
  artist_id: number;
  artist_name: string;
  title: string;
  url: string;
  art_id: number | null;
  release_date: string | null;
  about: string | null;
  credits: string | null;
  tags: string[];
  is_preorder: boolean;
  /** In the synced Bandcamp collection (purchased). */
  owned: boolean;
  /** On the synced Bandcamp wishlist. */
  wishlisted: boolean;
  fetched_at: string;
  created_at: string;
  track_count?: number;
  streamable_count?: number;
  /** Counted plays of the album's tracks (listening history). */
  play_count?: number;
  /** UTC `YYYY-MM-DD HH:MM:SS` of the latest play, or null if never played. */
  last_played_at?: string | null;
  /** Tracks with an offline copy (#2). */
  downloaded_count?: number;
  /** Your 0-5 star rating (#73), 0 when unrated. */
  rating?: number;
  /** Archived (#126): out of the Library's Albums tab unless Show is Archived; everything else still lists it. */
  archived: boolean;
}

/** A crate (#126): the user's own group of albums, listed in the sidebar. */
export interface Crate {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  album_count: number;
  /** Up to four distinct album art ids, in added order, for cover mosaics. */
  art_ids: number[];
}

export interface Track {
  id: number;
  track_id: number;
  album_id: number;
  title: string;
  track_num: number | null;
  duration: number | null;
  track_artist: string | null;
  streamable: boolean;
  lyrics: string | null;
  // denormalized for lists / player
  album_title?: string;
  artist_name?: string;
  art_id?: number | null;
  album_url?: string;
  /** Counted plays (listening history). */
  play_count?: number;
  /** Has an offline copy (#2); the player plays it instead of streaming. */
  downloaded?: boolean;
}

/** One counted play in the History view (#86): the track as it is now, plus when it was played. */
export interface HistoryEntry extends Track {
  play_id: number;
  /** UTC, "YYYY-MM-DD HH:MM:SS". */
  played_at: string;
}

/** Where the next History page starts: just older than this play. */
export interface HistoryCursor {
  played_at: string;
  id: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** null when this page reaches the oldest play. */
  next: HistoryCursor | null;
}

/** A Listening stats period (#94), in the user's local time. */
export type StatsPeriod = "month" | "year" | "all";

/**
 * Plays and listening time for one ranked row. `seconds` is the full length of each counted
 * play's track (a missing duration counts as 0), not seconds_listened, which stops at the
 * play threshold.
 */
export interface StatsCounts {
  plays: number;
  seconds: number;
}
export interface StatsArtist extends StatsCounts { artist_id: number; name: string; art_id: number | null }
export interface StatsAlbum extends StatsCounts { album_id: number; title: string; artist_name: string; art_id: number | null }
/** A tag, in the spelling that sorts first among ASCII-case variants (as the Tags tab shows it). */
export interface StatsTag extends StatsCounts { tag: string; art_id: number | null }

export interface ListeningStats {
  totals: StatsCounts & { albums: number };
  artists: StatsArtist[];
  albums: StatsAlbum[];
  tags: StatsTag[];
}

export interface AlbumWithTracks extends Album {
  tracks: Track[];
}

export interface Playlist {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  track_count?: number;
  /** Up to four distinct album art ids, in playlist order, for cover mosaics. */
  art_ids: number[];
  /** A smart playlist (#84): its tracks are `rule` evaluated now, never stored. */
  smart: boolean;
  /** The smart playlist's rule; null for an ordinary playlist (or a damaged rule). */
  rule: SmartRule | null;
}

export interface PlaylistTrack extends Track {
  playlist_track_id: number;
  position: number;
}

export interface PlaylistWithTracks extends Playlist {
  tracks: PlaylistTrack[];
}

/** "download": offline copies of an album's tracks (#2), one job item per track. */
export type JobKind = "album" | "track" | "discography" | "selection" | "collection" | "library" | "download";
/** "pending": created, items not yet inserted; the runner and the job list ignore it. */
export type JobStatus = "pending" | "queued" | "running" | "done" | "failed" | "cancelled";
/** A job that is not over yet: being created, waiting its turn, or in progress. */
export const ACTIVE_JOB_STATUSES = ["pending", "queued", "running"] as const satisfies readonly JobStatus[];
export const isActiveJob = (j: { status: JobStatus }): boolean => (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(j.status);

export interface JobItem {
  id: number;
  url: string;
  status: "queued" | "running" | "done" | "failed";
  album_id: number | null;
  error: string | null;
}

export interface Job {
  id: number;
  kind: JobKind;
  input_url: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  created_at: string;
  updated_at: string | null;
  items?: JobItem[];
}

export type RepeatMode = "off" | "all" | "one";

export interface QueueTrack extends Track {
  album_title: string;
  artist_name: string;
  art_id: number | null;
  /**
   * Set for a Bandcamp Radio episode (see services/radio.ts): `id` and `album_id` are then
   * minus the show id, so it never matches a library track and is never counted or saved
   * to a playlist.
   */
  radio?: QueueRadio;
  /**
   * Set for a Discover preview (#104, see services/discover.ts): an album's featured track
   * played without importing it. `id` and `album_id` are then -(1e10 + Bandcamp track id),
   * so it never matches a library track or a radio episode and is never counted or saved
   * to a playlist.
   */
  preview?: QueuePreview;
}

export interface PlayState {
  current_track_id: number | null;
  position_sec: number;
  queue: QueueTrack[];
  queue_index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
}

export type SearchResultType = "band" | "album" | "track";

export interface SearchResult {
  type: SearchResultType;
  id: number;
  name: string;
  artist: string | null;
  url: string;
  art_id: number | null;
  img: string | null;
  location: string | null;
  in_library: boolean;
}

/** A release listed on an artist or label page, with library status. */
export interface BrowseItem {
  url: string;
  item_type: ItemType;
  title: string;
  art_id: number | null;
  artist: string | null;
  /** Library album id when already imported. */
  album_id: number | null;
}

export interface BrowseResult {
  url: string;
  band: { band_id: number; name: string } | null;
  items: BrowseItem[];
}

/** How Bandcamp treated the identity cookie on the last sync. */
export type CookieStatus = "none" | "unchecked" | "ok" | "rejected" | "other_account";

/** Outcome of the last collection sync, kept in settings. */
export interface SyncSummary {
  /** ISO time the sync finished. */
  at: string;
  username: string;
  collection: number;
  wishlist: number;
  /** Items the sync queued for import (not yet in the library). */
  queued: number;
  /** Departed items were removed: both lists were read in full, with the access the last authenticated sync had. */
  complete: boolean;
  cookie: CookieStatus;
  /**
   * Some sync of this account was read with an accepted cookie. Sticky until the account
   * is removed: from then on only an authenticated sync may remove items, so an expired
   * cookie can't empty Purchased just because the signed-out view shows less.
   */
  authenticated: boolean;
  job_id: number;
}

/** The Bandcamp account in Settings. The cookie itself never leaves core. */
export interface AccountInfo {
  username: string | null;
  hasCookie: boolean;
  lastSync: SyncSummary | null;
}

/** A release on a library artist's /music page that appeared after the artist's first check. */
export interface NewRelease {
  id: number;
  artist_id: number;
  /** The release's own artist on a label page, else the library artist's name. */
  artist_name: string;
  url: string;
  item_type: ItemType;
  title: string;
  art_id: number | null;
  /** UTC `YYYY-MM-DD HH:MM:SS`, when a check first saw it. */
  first_seen: string;
}

/** The new-releases checker as Settings shows it. */
export interface ReleaseCheckStatus {
  enabled: boolean;
  /** ms timestamp of the most recent artist check, or null if none yet. */
  last_check_at: number | null;
  /** Library artists the checker covers (not muted). */
  artists: number;
  muted: number;
  /** A "Check now" pass is running. */
  running: boolean;
}

/** What one artist check did. */
export interface ArtistCheckResult {
  artist_id: number;
  status: "baseline" | "checked" | "failed" | "skipped";
  /** Releases on the page that passed URL normalisation. */
  releases: number;
  /** Rows this check inserted into artist_releases. */
  inserted_ids: number[];
  /** Of those, how many are new (always 0 for a baseline). */
  found: number;
  error?: string;
}

/** The background collection refresh as Settings shows it. */
export interface CollectionRefreshStatus {
  enabled: boolean;
  /** ms timestamp of the most recent automatic refresh, or null if none yet. */
  last_auto_at: number | null;
}

/** One Bandcamp Radio episode as the show list gives it (bandcamp.com/radio). */
export interface RadioShowSummary {
  /** Bandcamp's show id (the `?show=` number). */
  id: number;
  /** The episode's own title, usually the featured artist. */
  title: string;
  /** The programme it belongs to ("Bandcamp Selects", "The Metal Show", ...). */
  program: string;
  /** ISO time the episode was published, or null. */
  date: string | null;
  description: string | null;
  /** Bandcamp image id (no "a" prefix, see radioImageUrl). */
  image_id: number | null;
  /** Canonical show page, https://bandcamp.com/radio/<programme>/<id>. */
  url: string;
}

/** One featured track in an episode, with the playhead time it starts at. */
export interface RadioEntry {
  /** Seconds into the episode's audio. */
  timecode: number;
  duration: number | null;
  title: string;
  artist: string;
  album_title: string | null;
  art_id: number | null;
  /**
   * What Import and Buy link to: the album when the track is on one, else the track,
   * normalised with normalizeBandcampUrl. Null when Bandcamp gave nothing usable.
   */
  url: string | null;
  /** Library album id when `url` is already imported (set by core, not the parser). */
  album_id: number | null;
}

export interface RadioShow extends RadioShowSummary {
  /** Length of the episode's single audio file, in seconds. */
  duration: number | null;
  tracks: RadioEntry[];
}

/** Offline copies (#2) as Settings > Storage shows them. */
export interface OfflineStats {
  tracks: number;
  albums: number;
  /** Total size of the saved files. */
  bytes: number;
  /** The size limit in MB (1 MB = 1,000,000 bytes), or null for none. */
  cap_mb: number | null;
  /** False where there is no offline folder (the app couldn't create it). */
  available: boolean;
}

/** What a queue entry carries when it is a radio episode rather than a library track. */
export interface QueueRadio {
  show_id: number;
  image_id: number | null;
  program: string;
}

/** What a queue entry carries when it is a Discover preview rather than a library track. */
export interface QueuePreview {
  /** The release on Bandcamp (canonical album or track URL), for Add and Open on Bandcamp. */
  item_url: string;
  /** Bandcamp's id of the featured track. */
  track_id: number;
  /** The CDN URL discover gave (expires ~24 h later; core refreshes it). */
  stream_url: string;
}

/**
 * A release to play without importing it (core.previewRelease): either the library album
 * (`album_id` set, its own tracks, no request made) or preview entries for every track
 * Bandcamp streams, in album order. `start` is the featured track's index in `tracks`.
 */
export interface ReleasePreview {
  album_id: number | null;
  title: string;
  tracks: QueueTrack[];
  start: number;
}

/** Bandcamp discover's sort: best-selling, new arrivals, surprise me. */
export type DiscoverSlice = "top" | "new" | "rand";

/** The discover filters (#104). */
export interface DiscoverParams {
  /** Bandcamp tag norm names (e.g. "electronic", "glitch-hop"). */
  tags: string[];
  slice: DiscoverSlice;
  /** Bandcamp's time facet id (0 = today, 1 = this week, 2.. = n weeks ago), null for the default. */
  time: number | null;
  /** A geonames id, null for anywhere. */
  location: number | null;
  /** discover_web's category_id: 0 all, 1 digital, 2 vinyl, 3 cd, 4 cassette (DISCOVER_CATEGORIES). */
  category: number;
}

/** One release in Bandcamp discover's results. */
export interface DiscoverItem {
  /** Canonical album or track URL (no ?from=). */
  url: string;
  title: string;
  artist: string;
  /** The artist's or label's /music page, for Browse. */
  artist_url: string | null;
  art_id: number | null;
  item_type: ItemType;
  /** YYYY-MM-DD. */
  release_date: string | null;
  track_count: number | null;
  preorder: boolean;
  featured: { track_id: number; title: string; artist: string; duration: number | null; stream_url: string } | null;
  /** Library album id when already imported. */
  album_id: number | null;
}

export interface DiscoverPage {
  items: DiscoverItem[];
  /** How many releases match on Bandcamp. */
  total: number;
  /** For the next page, null at the end. */
  cursor: string | null;
}

export interface DiscoverTag {
  norm_name: string;
  display_name: string;
  count: number;
}

export interface DiscoverLocation {
  id: number;
  label: string;
}

/** The last Discover setup (settings.key='discover_last'). */
export interface DiscoverSetup extends DiscoverParams {
  location_label: string | null;
}
