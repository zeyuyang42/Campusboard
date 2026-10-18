-- Library import (see packages/core/src/services/libraryTransfer.ts).

-- Things a library file asked for that can't be written until an album, track or artist
-- exists here: playlist entries, plays, muted artists and dismissed new releases. Rows are
-- resolved after every import job item (and right after the import starts, for what the
-- library already holds), then deleted. dedupe_key is the entry's natural key, so reading
-- the same file twice adds nothing (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS import_pending (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('playlist_track','play','mute','dismissed')),
  dedupe_key TEXT NOT NULL UNIQUE,
  -- playlist_track: the playlist it belongs to and its place in the original order.
  playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER,
  -- playlist_track, play: the track, by Bandcamp track id, else album URL + number + title.
  album_url TEXT,
  track_bcid INTEGER,
  track_num INTEGER,
  track_title TEXT,
  -- play
  played_at TEXT,
  seconds REAL,
  -- mute, dismissed: the artist by Bandcamp band id.
  band_id INTEGER,
  -- dismissed: the release as artist_releases stores it.
  release_url TEXT,
  item_type TEXT,
  title TEXT,
  art_id INTEGER,
  artist_override TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_import_pending_kind ON import_pending(kind);

-- Playlists created from a library file, by "<source library id>:<source playlist id>", so
-- importing the same library again never creates them twice. Deleting the playlist drops the
-- row, so a later import may bring it back.
CREATE TABLE IF NOT EXISTS imported_playlists (
  source_key TEXT PRIMARY KEY,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE
);
