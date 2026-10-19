-- Album notes and ratings (#73, see packages/core/src/db/repos/albumNotes.ts). Personal,
-- local annotations per album, keyed by album id, which survives a re-import or refresh
-- (upsertTralbum updates the row in place); deleting the album deletes them.
-- A rating of 0 and an empty note mean "none"; the row stays so its updated_at keeps a
-- cleared note from coming back with an older library file.
CREATE TABLE IF NOT EXISTS album_notes (
  album_id INTEGER PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  -- UTC 'YYYY-MM-DD HH:MM:SS' of the last edit: a library import keeps whichever is newer.
  updated_at TEXT NOT NULL
);

-- Notes from a library file whose album isn't here yet, by album URL. Merged into
-- album_notes (newer edit wins) once the album arrives, then deleted.
CREATE TABLE IF NOT EXISTS album_notes_pending (
  album_url TEXT PRIMARY KEY,
  rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  updated_at TEXT NOT NULL
);
