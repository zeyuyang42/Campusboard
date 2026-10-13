import Database from "@tauri-apps/plugin-sql";
import { toDollar, type Db } from "@bc/core";

/** Db adapter over the Tauri SQL plugin. SQL in core uses `?`; the plugin wants `$n`. */
export class TauriDb implements Db {
  constructor(private db: Database) {}
  select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(toDollar(sql), params);
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.db.select<T[]>(toDollar(sql), params);
    return rows[0] ?? null;
  }
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertId: number }> {
    const r = await this.db.execute(toDollar(sql), params);
    return { changes: r.rowsAffected, lastInsertId: r.lastInsertId ?? 0 };
  }
}

export async function openDb(): Promise<Db> {
  // Migrations registered in src-tauri/src/lib.rs run on load; the file lives in the app's config dir.
  const db = await Database.load("sqlite:library.db");
  return new TauriDb(db);
}
