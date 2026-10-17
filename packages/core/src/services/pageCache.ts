import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { PAGE_CACHE_MAX_ROWS, PAGE_CACHE_MS, PAGE_CACHE_PRUNE_AGE_MS, PAGE_CACHE_PRUNE_INTERVAL_MS } from "../config.js";

/** Last prune time per database, so a long-running app keeps the table bounded. */
const lastPrune = new WeakMap<Db, number>();

/** Fetch a page through the queue, reusing a recent copy from the page_cache table. */
export async function cachedFetchText(db: Db, queue: FetchQueue, url: string, maxAge = PAGE_CACHE_MS): Promise<string> {
  if (maxAge > 0) {
    const hit = await db.get<{ html: string; fetched_at: number }>("SELECT html, fetched_at FROM page_cache WHERE url = ?", [url]);
    if (hit && Date.now() - hit.fetched_at < maxAge) return hit.html;
  }
  const html = await queue.fetchText(url);
  await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET html = excluded.html, fetched_at = excluded.fetched_at", [url, html, Date.now()]);
  // Best effort: a failed prune must not fail a fetch that already succeeded.
  if (Date.now() - (lastPrune.get(db) ?? 0) > PAGE_CACHE_PRUNE_INTERVAL_MS) await prunePageCache(db).catch(() => {});
  return html;
}

/**
 * Drop rows older than `olderThanMs`, then everything beyond the newest `maxRows`.
 * Two independent single statements (the Tauri plugin has no transactions); an
 * interruption between them still leaves a valid cache.
 */
export async function prunePageCache(db: Db, olderThanMs = PAGE_CACHE_PRUNE_AGE_MS, maxRows = PAGE_CACHE_MAX_ROWS): Promise<void> {
  lastPrune.set(db, Date.now());
  await db.run("DELETE FROM page_cache WHERE fetched_at < ?", [Date.now() - olderThanMs]);
  await db.run(
    "DELETE FROM page_cache WHERE url NOT IN (SELECT url FROM page_cache ORDER BY fetched_at DESC, url LIMIT ?)",
    [Math.max(0, Math.floor(maxRows))],
  );
}
