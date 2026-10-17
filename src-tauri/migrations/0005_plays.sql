-- Listening history: one row per counted playback (see packages/core/src/services/playRule.ts).
-- Rows go with their track (ON DELETE CASCADE), so removing an album or a re-import that drops
-- a track leaves no orphans; vacuumOrphans also sweeps any left by deletes with foreign keys off.
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL DEFAULT (datetime('now')),
  seconds_listened REAL NOT NULL DEFAULT 0
);
-- Per-track counts and last-played (track rows, and per album through ix_tracks_album).
CREATE INDEX IF NOT EXISTS ix_plays_track ON plays(track_id, played_at);
-- Most recent plays overall.
CREATE INDEX IF NOT EXISTS ix_plays_played_at ON plays(played_at);
