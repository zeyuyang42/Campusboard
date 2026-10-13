import { Hono } from "hono";
import type { Db } from "./db/connection.js";
import { JobRunner } from "./services/jobRunner.js";
import { ScrapeError } from "./scrape/errors.js";
import { importRoutes } from "./routes/import.js";
import { libraryRoutes } from "./routes/library.js";
import { trackRoutes } from "./routes/tracks.js";
import { playlistRoutes } from "./routes/playlists.js";
import { searchRoutes } from "./routes/search.js";
import { playStateRoutes } from "./routes/playState.js";

export type Env = { Variables: { db: Db; jobs: JobRunner } };

const STATUS: Record<string, number> = {
  invalid_url: 400, not_bandcamp: 400, not_found: 404, not_streamable: 409,
  client_challenge: 502, parse_failed: 502, fetch_failed: 502, bad_request: 400,
};

export class HttpError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function createApp(db: Db, jobs: JobRunner) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("jobs", jobs);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ScrapeError || err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, (STATUS[err.code] ?? 500) as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: err.message } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.path}` } }, 404));

  const api = new Hono<Env>();
  api.route("/", importRoutes);
  api.route("/", libraryRoutes);
  api.route("/", trackRoutes);
  api.route("/", playlistRoutes);
  api.route("/", searchRoutes);
  api.route("/", playStateRoutes);
  api.get("/health", (c) => c.json({ ok: true }));
  app.route("/api", api);
  return app;
}

export function idParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError("bad_request", `Invalid id: ${raw}`);
  return n;
}
