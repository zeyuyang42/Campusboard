// Shared DTOs between server and web.

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
}

export interface PlaylistTrack extends Track {
  playlist_track_id: number;
  position: number;
}

export interface PlaylistWithTracks extends Playlist {
  tracks: PlaylistTrack[];
}

export type JobKind = "album" | "track" | "discography" | "selection" | "collection";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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

export interface ApiError {
  error: { code: string; message: string };
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
