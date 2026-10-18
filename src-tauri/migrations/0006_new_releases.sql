-- New releases from library artists (see packages/core/src/services/releaseWatch.ts).
-- Both tables hang off artists(id) with ON DELETE CASCADE: removing an artist's last album
-- deletes the artist row, which stops its checks and drops what was found for it.
-- vacuumOrphans also sweeps rows left by deletes made with foreign keys off.

-- One row per artist the checker has looked at (or the user muted).
CREATE TABLE IF NOT EXISTS release_watch (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  -- 1: the user asked not to check this artist ("Don't check for new releases").
  muted INTEGER NOT NULL DEFAULT 0,
  -- 1 once a check succeeded: releases listed on that first check are the baseline (seen, not new).
  baselined INTEGER NOT NULL DEFAULT 0,
  -- ms timestamp of the last check (successful or not); due again 24 h later.
  last_checked_at INTEGER,
  last_error TEXT
);

-- Every release URL a check has seen on an artist's /music page.
-- status: 'seen' (baseline, or already in the library), 'new' (appeared after the baseline),
-- 'dismissed' (the user dismissed it). A 'new' row whose URL is in the library is not listed.
CREATE TABLE IF NOT EXISTS artist_releases (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,
  item_type TEXT NOT NULL CHECK (item_type IN ('album','track')),
  title TEXT NOT NULL,
  art_id INTEGER,
  -- Per-release artist on label pages; null means the artist's own name.
  artist_override TEXT,
  status TEXT NOT NULL CHECK (status IN ('seen','new','dismissed')),
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_artist_releases_status ON artist_releases(status, first_seen);
CREATE INDEX IF NOT EXISTS ix_artist_releases_artist ON artist_releases(artist_id);
