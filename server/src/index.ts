import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db/connection.js";
import { JobRunner } from "./services/jobRunner.js";
import { createApp } from "./app.js";
import { DB_PATH, PORT, WEB_DIST, ROOT_DIR } from "./config.js";

const db = openDb(DB_PATH);
const jobs = new JobRunner(db);
const app = createApp(db, jobs);

// In production, serve the built frontend with an SPA fallback.
if (existsSync(path.join(WEB_DIST, "index.html"))) {
  const rel = path.relative(process.cwd(), WEB_DIST) || ".";
  app.use("/*", serveStatic({ root: rel }));
  const index = readFileSync(path.join(WEB_DIST, "index.html"), "utf8");
  app.get("/*", (c) => c.html(index));
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`bandcamp-player listening on http://localhost:${info.port}  (db: ${path.relative(ROOT_DIR, DB_PATH)})`);
  void jobs.kick();
});
