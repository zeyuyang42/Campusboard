// Browser-only dev mode (VITE_BROWSER_MODE=1): the same SQL and migrations over sql.js
// (SQLite compiled to WebAssembly) so the UI can be exercised and screenshotted in a
// normal browser without Tauri. Data lives in memory for the tab's lifetime.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Db } from "@bc/core";
import m1 from "../../../src-tauri/migrations/0001_init.sql?raw";
import m2 from "../../../src-tauri/migrations/0002_settings.sql?raw";

export async function openBrowserDb(): Promise<Db> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(m1);
  db.exec(m2);
  const bind = (params: unknown[]) => params.map((p) => (p === undefined ? null : p)) as (string | number | null | Uint8Array)[];
  const api: Db = {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(bind(params));
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    async get<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return (await api.select<T>(sql, params))[0] ?? null;
    },
    async run(sql: string, params: unknown[] = []) {
      db.run(sql, bind(params));
      const changes = db.getRowsModified();
      const r = db.exec("SELECT last_insert_rowid()");
      return { changes, lastInsertId: Number(r[0]?.values[0]?.[0] ?? 0) };
    },
  };
  return api;
}

/** Route Bandcamp fetches through the Vite dev proxy, which strips CORS. */
export function browserFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(`/bc-proxy/${encodeURIComponent(input)}`, init);
}
