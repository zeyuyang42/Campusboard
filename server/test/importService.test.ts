import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { listAlbums, getAlbumWithTracks } from "../src/db/repos/albums.js";
import { fixture } from "./helpers.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

const album = () => parseTralbumPage(fixture("album"), 0);
const track = () => parseTralbumPage(fixture("track"), 0);

describe("upsertTralbum", () => {
  it("imports an album idempotently", () => {
    const id1 = upsertTralbum(db, album());
    const id2 = upsertTralbum(db, album());
    expect(id1).toBe(id2);
    expect(listAlbums(db)).toHaveLength(1);
    const a = getAlbumWithTracks(db, id1)!;
    expect(a.tracks).toHaveLength(12);
    expect(a.artist_name).toBe("illuminati hotties");
    expect(a.tags).toContain("indie");
  });
  it("re-parents a single track into its album when the album is imported later", () => {
    const tid = upsertTralbum(db, track());
    expect(listAlbums(db)[0].item_type).toBe("track");
    const aid = upsertTralbum(db, album());
    expect(aid).not.toBe(tid);
    expect(listAlbums(db)).toHaveLength(1);
    expect(getAlbumWithTracks(db, aid)!.tracks.find((t) => t.track_id === 282506895)).toBeTruthy();
  });
  it("does not split a track out of an existing album when its /track page is imported", () => {
    const aid = upsertTralbum(db, album());
    const t = track();
    t.tracks[0].stream_url = "https://t4.bcbits.com/stream/x/mp3-128/1?ts=2000000000";
    t.tracks[0].stream_expires_at = 2000000000000;
    expect(upsertTralbum(db, t)).toBe(aid);
    expect(listAlbums(db)).toHaveLength(1);
    const row = db.prepare("SELECT stream_expires_at FROM tracks WHERE track_id = 282506895").get() as { stream_expires_at: number };
    expect(row.stream_expires_at).toBe(2000000000000);
  });
  it("drops tracks that vanished from a re-scraped album", () => {
    const aid = upsertTralbum(db, album());
    const a = album();
    a.tracks = a.tracks.slice(0, 5);
    upsertTralbum(db, a);
    expect(getAlbumWithTracks(db, aid)!.tracks).toHaveLength(5);
  });
});
