import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/Db.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../src-tauri/migrations");

/** node:sqlite adapter for tests: same migrations as the app, synchronous underneath. */
export class NodeDb implements Db {
  readonly raw: DatabaseSync;
  constructor(file = ":memory:") {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      this.raw.exec(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
    }
  }
  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params as never[])) as unknown as T[];
  }
  async get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return ((this.raw.prepare(sql).get(...(params as never[])) as unknown as T) ?? null);
  }
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertId: number }> {
    const r = this.raw.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
  }
}
