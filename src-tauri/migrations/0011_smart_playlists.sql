-- Smart playlists (#84, see packages/core/src/db/repos/smartPlaylists.ts). A playlist with a
-- row here is smart: its tracks are the rule evaluated at open/play time, never stored, so
-- playlist_tracks stays empty for it. A side table rather than a playlists column because
-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS, and every migration here must be safe to re-run
-- over an old library.db. rule_json is validated with SmartRuleSchema on every read.
CREATE TABLE IF NOT EXISTS smart_playlists (
  playlist_id INTEGER PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
  rule_json TEXT NOT NULL
);
