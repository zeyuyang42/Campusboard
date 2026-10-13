import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import { HttpError } from "../app.js";
import { getPlayState, setPlayState } from "../db/repos/playState.js";

const Body = z.object({
  current_track_id: z.number().int().nullable(),
  position_sec: z.number().min(0),
  queue: z.array(z.object({ id: z.number().int() }).passthrough()),
  queue_index: z.number().int().min(0),
  shuffle: z.boolean(),
  repeat: z.enum(["off", "all", "one"]),
  volume: z.number().min(0).max(1),
});

export const playStateRoutes = new Hono<Env>()
  .get("/play-state", (c) => c.json({ state: getPlayState(c.get("db")) }))
  .put("/play-state", async (c) => {
    const r = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success) throw new HttpError("bad_request", r.error.issues[0]?.message ?? "Invalid body");
    setPlayState(c.get("db"), r.data as never);
    return c.json({ ok: true });
  });
