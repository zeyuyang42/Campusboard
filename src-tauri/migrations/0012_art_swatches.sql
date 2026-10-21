-- Vivid backdrop (#110, palette v2): up to 6 raw art colours per image, as JSON, boosted at read
-- time (packages/core/src/palette/boost.ts). Positive art_key = Bandcamp art_id, negative =
-- -(Radio image_id). art_palettes stays for the conservative backdrop.
CREATE TABLE IF NOT EXISTS art_swatches (
  art_key INTEGER PRIMARY KEY,
  swatches TEXT NOT NULL,
  version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);
