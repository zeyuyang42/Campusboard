-- Offline copies of tracks (#2, see packages/core/src/services/offline.ts).
-- tracks.local_path (0001) names a track's file inside the offline folder ("<track_id>.mp3");
-- this table holds its size for Settings > Storage and the size limit. A download writes the
-- file, then this row, then local_path; a removal clears local_path, then this row, then the
-- file. The offline sweep repairs whatever an interruption left half done: a row here without
-- a local_path, or a file that neither names, is removed.
CREATE TABLE IF NOT EXISTS track_files (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL,
  -- The stream it was saved from: 'mp3-128', or 'mp3-v0' for a purchase fetched with the cookie.
  quality TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
