import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { listAlbums, getAlbumWithTracks } from "../src/db/repos/albums.js";
import { fixture } from "./helpers.js";

let db: NodeDb;
beforeEach(() => { db = new NodeDb(); });

const album = () => parseTralbumPage(fixture("album"), 0);
const track = () => parseTralbumPage(fixture("track"), 0);

describe("upsertTralbum", () => {
  it("imports an album idempotently", async () => {
    const id1 = await upsertTralbum(db, album());
    const id2 = await upsertTralbum(db, album());
    expect(id1).toBe(id2);
    expect(await listAlbums(db)).toHaveLength(1);
    const a = (await getAlbumWithTracks(db, id1))!;
    expect(a.tracks).toHaveLength(12);
    expect(a.artist_name).toBe("illuminati hotties");
    expect(a.tags).toContain("indie");
  });
  it("re-parents a single track into its album when the album is imported later", async () => {
    const tid = await upsertTralbum(db, track());
    expect((await listAlbums(db))[0].item_type).toBe("track");
    const aid = await upsertTralbum(db, album());
    expect(aid).not.toBe(tid);
    expect(await listAlbums(db)).toHaveLength(1);
    expect((await getAlbumWithTracks(db, aid))!.tracks.find((t) => t.track_id === 282506895)).toBeTruthy();
  });
  it("does not split a track out of an existing album when its /track page is imported", async () => {
    const aid = await upsertTralbum(db, album());
    const t = track();
    t.tracks[0].stream_url = "https://t4.bcbits.com/stream/x/mp3-128/1?ts=2000000000";
    t.tracks[0].stream_expires_at = 2000000000000;
    expect(await upsertTralbum(db, t)).toBe(aid);
    expect(await listAlbums(db)).toHaveLength(1);
    const row = await db.get<{ stream_expires_at: number }>("SELECT stream_expires_at FROM tracks WHERE track_id = 282506895");
    expect(row!.stream_expires_at).toBe(2000000000000);
  });
  it("drops tracks that vanished from a re-scraped album", async () => {
    const aid = await upsertTralbum(db, album());
    const a = album();
    a.tracks = a.tracks.slice(0, 5);
    await upsertTralbum(db, a);
    expect((await getAlbumWithTracks(db, aid))!.tracks).toHaveLength(5);
  });
});
