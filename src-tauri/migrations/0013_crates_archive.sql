-- Crates and Archive (#126, see packages/core/src/db/repos/crates.ts and albumArchive.ts).
-- Side tables keyed by album id, which survives a re-import or refresh; deleting the album
-- deletes its rows. Every statement is IF NOT EXISTS so an old library.db can be adopted.

-- A crate: the user's own group of albums (nothing to do with Bandcamp's tags). An album may
-- be in any number of crates.
CREATE TABLE IF NOT EXISTS crates (
  id INTEGER PRIMARY KEY,
  -- No upper bound here (playlists has none either): length() counts code points, while the
  -- repo caps names at 100 user-perceived characters, which may be more code points.
  name TEXT NOT NULL CHECK (length(name) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crate_albums (
  crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (crate_id, album_id)
);
CREATE INDEX IF NOT EXISTS ix_crate_albums_album ON crate_albums(album_id);

-- An album with a row here is archived: left out of the Library's Albums tab (and its
-- Recently played row and bulk bar) unless Show is Archived. Everything else still sees it.
CREATE TABLE IF NOT EXISTS album_archive (
  album_id INTEGER PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  archived_at TEXT NOT NULL
);

-- From a library file: crate memberships and archive marks whose album isn't here yet, by
-- album URL (the album_notes_pending pattern). Merged once the album arrives, then deleted.
CREATE TABLE IF NOT EXISTS crate_albums_pending (
  crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  album_url TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (crate_id, album_url)
);
CREATE TABLE IF NOT EXISTS album_archive_pending (
  album_url TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL
);

-- Which crate an earlier import of a library file created for its crate key, so importing
-- the same file again finds it (the imported_playlists pattern).
CREATE TABLE IF NOT EXISTS imported_crates (
  source_key TEXT PRIMARY KEY,
  crate_id INTEGER REFERENCES crates(id) ON DELETE CASCADE
);
