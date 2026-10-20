-- Resume points for long tracks and Radio episodes (#85, see packages/core/src/db/repos/resumePositions.ts).
-- Keyed by the queue entry's id: a library track's id, or minus the show id for a Radio
-- episode (radioQueueTrack), so there is no foreign key; vacuumOrphans drops the rows of
-- tracks that are gone. At most RESUME_MAX_ROWS rows: each save removes the oldest beyond.
CREATE TABLE IF NOT EXISTS resume_positions (
  item_id INTEGER PRIMARY KEY,
  position_sec REAL NOT NULL CHECK (position_sec >= 0),
  -- Date.now() of the save, in ms: orders the rows for the cap.
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_resume_saved_at ON resume_positions(saved_at);
