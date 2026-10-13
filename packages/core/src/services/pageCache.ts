import type { Db } from "../db/Db.js";
import type { FetchQueue } from "../scrape/http.js";
import { PAGE_CACHE_MS } from "../config.js";

/** Fetch a page through the queue, reusing a recent copy from the page_cache table. */
export async function cachedFetchText(db: Db, queue: FetchQueue, url: string, maxAge = PAGE_CACHE_MS): Promise<string> {
  if (maxAge > 0) {
    const hit = await db.get<{ html: string; fetched_at: number }>("SELECT html, fetched_at FROM page_cache WHERE url = ?", [url]);
    if (hit && Date.now() - hit.fetched_at < maxAge) return hit.html;
  }
  const html = await queue.fetchText(url);
  await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET html = excluded.html, fetched_at = excluded.fetched_at", [url, html, Date.now()]);
  return html;
}

export async function prunePageCache(db: Db, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  await db.run("DELETE FROM page_cache WHERE fetched_at < ?", [Date.now() - olderThanMs]);
}
