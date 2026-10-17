-- What the Bandcamp account's collection (purchases) and wishlist held at the last sync.
-- Kept apart from albums so membership survives an item that failed to import or was
-- removed from the library, and a re-sync can drop departed items with one statement.
-- albums.owned is recomputed from the 'collection' rows; "wishlisted" is read from here.
CREATE TABLE IF NOT EXISTS fan_items (
  list TEXT NOT NULL CHECK (list IN ('collection','wishlist')),
  item_type TEXT NOT NULL CHECK (item_type IN ('album','track')),
  bandcamp_id INTEGER NOT NULL,
  -- Canonical item URL as Bandcamp lists it (may be an artist's custom domain).
  url TEXT NOT NULL,
  -- The same page on name.bandcamp.com, the only host the identity cookie is sent to.
  fetch_url TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  -- Id of the sync job that last saw this item; rows a finished sync didn't see are removed.
  sync_job INTEGER NOT NULL,
  PRIMARY KEY (list, item_type, bandcamp_id)
);
CREATE INDEX IF NOT EXISTS ix_fan_items_item ON fan_items(item_type, bandcamp_id);
CREATE INDEX IF NOT EXISTS ix_fan_items_fetch ON fan_items(fetch_url);
