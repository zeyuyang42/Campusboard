import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import { HttpError, idParam } from "../app.js";
import * as jobs from "../db/repos/jobs.js";

const Body = z.object({ url: z.string().min(1), force: z.boolean().optional() });

export const importRoutes = new Hono<Env>()
  .post("/import", async (c) => {
    const body = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError("bad_request", "Body must be {url: string}");
    const job = c.get("jobs").enqueue(body.data);
    return c.json({ job }, 202);
  })
  .get("/jobs", (c) => c.json({ jobs: jobs.listJobs(c.get("db")) }))
  .get("/jobs/:id", (c) => {
    const job = jobs.getJob(c.get("db"), idParam(c.req.param("id")));
    if (!job) throw new HttpError("not_found", "Job not found");
    return c.json({ job });
  })
  .post("/jobs/:id/cancel", (c) => {
    const ok = c.get("jobs").cancel(idParam(c.req.param("id")));
    return c.json({ cancelled: ok });
  });
