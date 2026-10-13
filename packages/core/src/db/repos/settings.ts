import type { Db } from "../Db.js";
import { now } from "../Db.js";

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const r = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!r) return null;
  try { return JSON.parse(r.value) as T; } catch { return null; }
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, JSON.stringify(value), now()]);
}
