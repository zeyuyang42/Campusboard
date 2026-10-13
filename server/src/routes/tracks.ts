import { Hono } from "hono";
import type { Env } from "../app.js";
import { idParam } from "../app.js";
import { getFreshStreamUrl } from "../services/streamService.js";

export const trackRoutes = new Hono<Env>()
  .get("/tracks/:id/stream", async (c) => {
    const r = await getFreshStreamUrl(c.get("db"), idParam(c.req.param("id")), c.req.query("force") === "1");
    return c.json(r);
  })
  // The <audio> element points here; the browser follows the redirect and talks to the CDN directly.
  .get("/tracks/:id/audio", async (c) => {
    const r = await getFreshStreamUrl(c.get("db"), idParam(c.req.param("id")), c.req.query("force") === "1");
    c.header("Cache-Control", "no-store");
    return c.redirect(r.url, 302);
  });
