import { describe, it, expect, beforeEach } from "vitest";
import { toDollar, valuesList } from "../src/db/Db.js";
import { NodeDb } from "./helpers/nodeDb.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import * as pl from "../src/db/repos/playlists.js";
import { getAlbumWithTracks } from "../src/db/repos/albums.js";
import { fixture } from "./helpers.js";

describe("toDollar", () => {
  it("numbers placeholders and skips question marks inside quotes", () => {
    expect(toDollar("SELECT ? , ?")).toBe("SELECT $1 , $2");
    expect(toDollar(`SELECT '?' , ?, "a?b", 'it''s?' , ?`)).toBe(`SELECT '?' , $1, "a?b", 'it''s?' , $2`);
    expect(toDollar("no placeholders")).toBe("no placeholders");
  });
  it("builds multi-row value lists", () => {
    expect(valuesList(2, 3)).toBe("(?,?,?),(?,?,?)");
  });
});

describe("playlists without transactions", () => {
  let db: NodeDb;
  let trackIds: number[];
  beforeEach(async () => {
    db = new NodeDb();
    const aid = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
    trackIds = (await getAlbumWithTracks(db, aid))!.tracks.map((t) => t.id);
  });
  it("appends with increasing positions and reorders in one statement", async () => {
    const p = await pl.createPlaylist(db, "mix");
    await pl.addTracks(db, p.id, trackIds.slice(0, 3));
    await pl.addTracks(db, p.id, trackIds.slice(3, 5));
    let got = (await pl.getPlaylist(db, p.id))!;
    expect(got.tracks.map((t) => t.position)).toEqual([0, 1, 2, 3, 4]);
    const ids = got.tracks.map((t) => t.playlist_track_id);
    await pl.reorder(db, p.id, [ids[4], ids[0], ids[1], ids[2], ids[3]]);
    got = (await pl.getPlaylist(db, p.id))!;
    expect(got.tracks.map((t) => t.playlist_track_id)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
    expect(got.art_ids).toEqual([872064409]);
    expect((await pl.listPlaylists(db))[0].track_count).toBe(5);
    expect(await pl.playlistsContaining(db, trackIds.slice(0, 2))).toEqual(new Set([p.id]));
    expect(await pl.playlistsContaining(db, [trackIds[11]])).toEqual(new Set());
  });
});
