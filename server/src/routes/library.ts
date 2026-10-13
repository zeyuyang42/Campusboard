import { Hono } from "hono";
import type { Env } from "../app.js";
import { HttpError, idParam } from "../app.js";
import * as artists from "../db/repos/artists.js";
import * as albums from "../db/repos/albums.js";
import { searchTracks } from "../db/repos/tracks.js";
import { refreshAlbum } from "../services/streamService.js";

export const libraryRoutes = new Hono<Env>()
  .get("/artists", (c) => c.json({ artists: artists.listArtists(c.get("db")) }))
  .get("/artists/:id", (c) => {
    const a = artists.getArtist(c.get("db"), idParam(c.req.param("id")));
    if (!a) throw new HttpError("not_found", "Artist not found");
    return c.json({ artist: a });
  })
  .get("/albums", (c) => c.json({ albums: albums.listAlbums(c.get("db"), (c.req.query("sort") as albums.AlbumSort) ?? "added") }))
  .get("/albums/:id", (c) => {
    const a = albums.getAlbumWithTracks(c.get("db"), idParam(c.req.param("id")));
    if (!a) throw new HttpError("not_found", "Album not found");
    return c.json({ album: a });
  })
  .delete("/albums/:id", (c) => {
    const ok = albums.deleteAlbum(c.get("db"), idParam(c.req.param("id")));
    if (!ok) throw new HttpError("not_found", "Album not found");
    return c.json({ deleted: true });
  })
  .post("/albums/:id/refresh", async (c) => {
    const db = c.get("db");
    const id = idParam(c.req.param("id"));
    const a = albums.getAlbum(db, id);
    if (!a) throw new HttpError("not_found", "Album not found");
    await refreshAlbum(db, id, a.url);
    return c.json({ album: albums.getAlbumWithTracks(db, id) });
  })
  .get("/tracks", (c) => c.json({ tracks: searchTracks(c.get("db"), c.req.query("q") ?? "") }));
