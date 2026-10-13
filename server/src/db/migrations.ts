// Migrations are embedded so the production build needs no .sql copies.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  band_id INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE albums (
  id INTEGER PRIMARY KEY,
  bandcamp_id INTEGER NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('album','track')),
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  art_id INTEGER,
  release_date TEXT,
  about TEXT,
  credits TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_preorder INTEGER NOT NULL DEFAULT 0,
  owned INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_type, bandcamp_id)
);
CREATE INDEX ix_albums_url ON albums(url);
CREATE INDEX ix_albums_artist ON albums(artist_id);
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  track_id INTEGER UNIQUE NOT NULL,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  track_num INTEGER,
  duration REAL,
  track_artist TEXT,
  streamable INTEGER NOT NULL DEFAULT 0,
  stream_quality TEXT NOT NULL DEFAULT 'mp3-128',
  stream_url TEXT,
  stream_expires_at INTEGER,
  lyrics TEXT,
  local_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_tracks_album ON tracks(album_id, track_num);
CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE playlist_tracks (
  id INTEGER PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_pt_playlist ON playlist_tracks(playlist_id, position);
CREATE TABLE play_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_track_id INTEGER,
  position_sec REAL NOT NULL DEFAULT 0,
  queue_json TEXT NOT NULL DEFAULT '[]',
  queue_index INTEGER NOT NULL DEFAULT 0,
  shuffle INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT 'off',
  volume REAL NOT NULL DEFAULT 1,
  updated_at TEXT
);
INSERT INTO play_state (id) VALUES (1);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  input_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE job_items (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  album_id INTEGER,
  error TEXT
);
CREATE INDEX ix_job_items_job ON job_items(job_id, id);
CREATE TABLE page_cache (
  url TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`,
  },
];
