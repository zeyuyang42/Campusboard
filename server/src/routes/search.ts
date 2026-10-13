import { Hono } from "hono";
import type { Env } from "../app.js";
import { searchBandcamp } from "../scrape/search.js";
import type { SearchResult } from "@bc/shared";

export const searchRoutes = new Hono<Env>().get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ results: [] as SearchResult[] });
  const db = c.get("db");
  const raw = await searchBandcamp(q);
  const albumUrls = new Set((db.prepare("SELECT url FROM albums").all() as { url: string }[]).map((r) => r.url));
  const artistUrls = new Set((db.prepare("SELECT url FROM artists").all() as { url: string }[]).map((r) => r.url));
  const results: SearchResult[] = raw.map((r) => ({ ...r, in_library: r.type === "band" ? artistUrls.has(r.url) : albumUrls.has(r.url) }));
  return c.json({ results });
});
