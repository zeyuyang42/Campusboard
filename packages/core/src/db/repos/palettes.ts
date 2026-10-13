import type { Db } from "../Db.js";
import type { ArtPalette } from "../../palette/index.js";

export async function getCachedPalette(db: Db, artId: number): Promise<ArtPalette | null> {
  const r = await db.get<{ accent: string; ambient1: string; ambient2: string }>("SELECT accent, ambient1, ambient2 FROM art_palettes WHERE art_id = ?", [artId]);
  return r ? { accent: r.accent, ambient1: r.ambient1, ambient2: r.ambient2 } : null;
}

export async function cachePalette(db: Db, artId: number, p: ArtPalette): Promise<void> {
  await db.run(
    "INSERT INTO art_palettes (art_id, accent, ambient1, ambient2, computed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(art_id) DO UPDATE SET accent = excluded.accent, ambient1 = excluded.ambient1, ambient2 = excluded.ambient2, computed_at = excluded.computed_at",
    [artId, p.accent, p.ambient1, p.ambient2, Date.now()],
  );
}
