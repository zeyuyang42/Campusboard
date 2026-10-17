/**
 * Minimal async database interface. Implemented by the Tauri SQL plugin in the app
 * and by node:sqlite in tests. SQL is written with `?` placeholders; adapters that
 * need `$n` convert with toDollar().
 */
export interface Db {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertId: number }>;
}

/** Rewrite `?` placeholders to `$1..$n`, ignoring question marks inside quoted strings. */
export function toDollar(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += quote; i++; } else quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else out += ch;
  }
  return out;
}

/**
 * Current time in UTC as `YYYY-MM-DD HH:MM:SS`: the same format and zone as SQLite's
 * `datetime('now')` (also UTC), so values written from JS and by SQL column defaults
 * compare and sort together. Convert to local time only for display.
 */
export const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Build `(?,?,..),(?,?,..)` for a multi-row insert. */
export function valuesList(rows: number, cols: number): string {
  const row = `(${Array(cols).fill("?").join(",")})`;
  return Array(rows).fill(row).join(",");
}

/**
 * A `%term%` pattern for `LIKE ? ESCAPE '\'` with the user's own `%`, `_` and `\`
 * escaped, so they match literally. SQLite's LIKE folds ASCII case only.
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
