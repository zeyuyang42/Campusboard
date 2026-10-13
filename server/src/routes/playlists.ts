import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import { HttpError, idParam } from "../app.js";
import * as pl from "../db/repos/playlists.js";

const Name = z.object({ name: z.string().trim().min(1).max(200) });
const TrackIds = z.object({ track_ids: z.array(z.number().int().positive()).min(1) });
const Order = z.object({ playlist_track_ids: z.array(z.number().int().positive()) });

async function body<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodSchema<T>): Promise<T> {
  const r = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!r.success) throw new HttpError("bad_request", r.error.issues[0]?.message ?? "Invalid body");
  return r.data;
}

export const playlistRoutes = new Hono<Env>()
  .get("/playlists", (c) => c.json({ playlists: pl.listPlaylists(c.get("db")) }))
  .post("/playlists", async (c) => c.json({ playlist: pl.createPlaylist(c.get("db"), (await body(c, Name)).name) }, 201))
  .get("/playlists/:id", (c) => {
    const p = pl.getPlaylist(c.get("db"), idParam(c.req.param("id")));
    if (!p) throw new HttpError("not_found", "Playlist not found");
    return c.json({ playlist: p });
  })
  .patch("/playlists/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!pl.renamePlaylist(c.get("db"), id, (await body(c, Name)).name)) throw new HttpError("not_found", "Playlist not found");
    return c.json({ playlist: pl.getPlaylist(c.get("db"), id) });
  })
  .delete("/playlists/:id", (c) => {
    if (!pl.deletePlaylist(c.get("db"), idParam(c.req.param("id")))) throw new HttpError("not_found", "Playlist not found");
    return c.json({ deleted: true });
  })
  .post("/playlists/:id/tracks", async (c) => {
    const id = idParam(c.req.param("id"));
    if (!pl.getPlaylist(c.get("db"), id)) throw new HttpError("not_found", "Playlist not found");
    pl.addTracks(c.get("db"), id, (await body(c, TrackIds)).track_ids);
    return c.json({ playlist: pl.getPlaylist(c.get("db"), id) });
  })
  .put("/playlists/:id/order", async (c) => {
    const id = idParam(c.req.param("id"));
    pl.reorder(c.get("db"), id, (await body(c, Order)).playlist_track_ids);
    return c.json({ playlist: pl.getPlaylist(c.get("db"), id) });
  })
  .delete("/playlists/:id/tracks/:ptid", (c) => {
    const id = idParam(c.req.param("id"));
    if (!pl.removeTrack(c.get("db"), id, idParam(c.req.param("ptid")))) throw new HttpError("not_found", "Playlist track not found");
    return c.json({ playlist: pl.getPlaylist(c.get("db"), id) });
  });
