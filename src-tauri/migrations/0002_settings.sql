CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS art_palettes (
  art_id INTEGER PRIMARY KEY,
  accent TEXT NOT NULL,
  ambient1 TEXT NOT NULL,
  ambient2 TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
