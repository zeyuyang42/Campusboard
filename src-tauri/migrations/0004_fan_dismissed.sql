-- Purchased or wishlisted releases the user removed from the library. A sync keeps their
-- membership (and Purchased mark data) but no longer imports them again. Importing the
-- release by hand clears the row. Kept apart from fan_items so removing the account
-- (which empties fan_items) doesn't bring every removed album back on the next sync.
CREATE TABLE IF NOT EXISTS fan_dismissed (
  item_type TEXT NOT NULL CHECK (item_type IN ('album','track')),
  bandcamp_id INTEGER NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_type, bandcamp_id)
);
