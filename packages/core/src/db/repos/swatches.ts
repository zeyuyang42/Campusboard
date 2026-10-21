// Palette v2 (#110): raw art swatches per image (`art_swatches`, migration 0012). Positive
// art_key = Bandcamp art_id, negative = -(Radio image_id). Rows are JSON validated on read.
import type { Db } from "../Db.js";
import { ArtSwatchesSchema, type ArtSwatches } from "../../palette/index.js";

/** An art key: album art by art_id, or a Radio episode image by image_id (stored negative). */
export type ArtKey = { artId: number } | { imageId: number };

export function artKeyOf(key: ArtKey): number | null {
  const n = "artId" in key ? key.artId : -key.imageId;
  return Number.isInteger(n) && n !== 0 ? n : null;
}

export async function getCachedSwatches(db: Db, artKey: number): Promise<ArtSwatches | null> {
  const r = await db.get<{ swatches: string; version: number }>("SELECT swatches, version FROM art_swatches WHERE art_key = ?", [artKey]);
  if (!r || r.version !== 1) return null;
  try {
    const parsed = ArtSwatchesSchema.safeParse(JSON.parse(r.swatches));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function cacheSwatches(db: Db, artKey: number, s: ArtSwatches): Promise<void> {
  await db.run(
    "INSERT INTO art_swatches (art_key, swatches, version, computed_at) VALUES (?, ?, ?, ?) ON CONFLICT(art_key) DO UPDATE SET swatches = excluded.swatches, version = excluded.version, computed_at = excluded.computed_at",
    [artKey, JSON.stringify(s), s.version, Date.now()],
  );
}
