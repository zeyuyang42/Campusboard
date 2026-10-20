import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { recordPlay, clearPlays, listPlays, historySql } from "../src/db/repos/plays.js";
import { getAlbumWithTracks, deleteAlbum } from "../src/db/repos/albums.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";

describe("listPlays (History view, #86)", () => {
  let db: NodeDb;
  let albumId: number;
  let trackIds: number[];
  const play = async (trackId: number, when: string) => {
    const id = (await recordPlay(db, trackId, 100))!;
    db.raw.prepare("UPDATE plays SET played_at = ? WHERE id = ?").run(when, id);
    return id;
  };

  beforeEach(async () => {
    db = new NodeDb();
    albumId = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
    trackIds = (await getAlbumWithTracks(db, albumId))!.tracks.map((t) => t.id);
  });

  it("lists plays newest first with their track, album and artist", async () => {
    await play(trackIds[0], "2026-10-01 10:00:00");
    await play(trackIds[1], "2026-10-02 10:00:00");
    await play(trackIds[0], "2026-10-03 10:00:00");
    const { entries, next } = await listPlays(db);
    expect(entries.map((e) => [e.id, e.played_at])).toEqual([
      [trackIds[0], "2026-10-03 10:00:00"], [trackIds[1], "2026-10-02 10:00:00"], [trackIds[0], "2026-10-01 10:00:00"],
    ]);
    expect(next).toBeNull();
    const album = (await getAlbumWithTracks(db, albumId))!;
    expect(entries[0]).toMatchObject({ album_id: albumId, album_title: album.title, artist_name: album.artist_name, play_count: 2, streamable: true });
    expect(entries[0].art_id).toBe(album.art_id);
    expect(entries[0]).not.toHaveProperty("stream_url");
    expect(new Set(entries.map((e) => e.play_id)).size).toBe(3);
  });

  it("pages by (played_at, id) without skipping or repeating plays with equal timestamps", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(await play(trackIds[i % trackIds.length], i < 5 ? "2026-10-05 12:00:00" : "2026-10-04 08:00:00"));
    const seen: number[] = [];
    let page = await listPlays(db, null, 3);
    seen.push(...page.entries.map((e) => e.play_id));
    // A play recorded between pages lands on top and doesn't shift what follows.
    await play(trackIds[0], "2026-10-09 00:00:00");
    while (page.next) {
      page = await listPlays(db, page.next, 3);
      seen.push(...page.entries.map((e) => e.play_id));
    }
    // Same second: the later id first; then the older day.
    expect(seen).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0], ids[6], ids[5]]);
  });

  it("ends exactly at the last page", async () => {
    for (let i = 0; i < 4; i++) await play(trackIds[0], `2026-10-0${i + 1} 10:00:00`);
    const a = await listPlays(db, null, 2);
    expect(a.next).not.toBeNull();
    const b = await listPlays(db, a.next, 2);
    expect(b.entries).toHaveLength(2);
    expect(b.next).toBeNull();
  });

  it("drops an album's plays when the album is deleted, and is empty after clearing", async () => {
    db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (99, 'Other', 'https://other.bandcamp.com')").run();
    const ar = Number(db.raw.prepare("SELECT id FROM artists WHERE band_id = 99").get()!.id);
    const al = Number(db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (1, 'album', ?, 'Other album', 'https://other.bandcamp.com/album/x', '2026-01-01') RETURNING id").get(ar)!.id);
    const t = Number(db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, duration) VALUES (1, ?, 'Other track', 200) RETURNING id").get(al)!.id);
    await play(trackIds[0], "2026-10-01 10:00:00");
    await play(t, "2026-10-02 10:00:00");
    await deleteAlbum(db, albumId);
    const { entries } = await listPlays(db);
    expect(entries.map((e) => [e.id, e.album_title, e.artist_name])).toEqual([[t, "Other album", "Other"]]);
    await clearPlays(db);
    expect(await listPlays(db)).toEqual({ entries: [], next: null });
  });

  it("walks ix_plays_played_at instead of sorting", () => {
    const cases: [boolean, unknown[]][] = [[false, [51]], [true, ["2026-10-01 00:00:00", 5, 51]]];
    for (const [cursor, args] of cases) {
      const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${historySql(cursor)}`).all(...(args as never[])).map((r) => String(r.detail));
      expect(plan[0]).toMatch(/^(SCAN|SEARCH) p USING (COVERING )?INDEX ix_plays_played_at/);
      expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
    }
  });
});
