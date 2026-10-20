import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { listeningStats, periodBounds, statsSql } from "../src/db/repos/stats.js";
import { clearPlays } from "../src/db/repos/plays.js";
import { markRemoving, unmarkRemoving } from "../src/db/repos/albumRemoval.js";

// Periods are local time; pin a zone with a DST change (1 Nov 2026) right at a month boundary.
const savedTz = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

describe("listening stats (#94)", () => {
  let db: NodeDb;
  let n = 0;
  const artist = (name: string) => Number(db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (?, ?, ?) RETURNING id").get(++n, name, `https://a${n}.bandcamp.com`)!.id);
  const album = (artistId: number, title: string, tags: unknown = [], artId: number | null = n) =>
    Number(db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, art_id, tags_json, fetched_at) VALUES (?, 'album', ?, ?, ?, ?, ?, '2026-01-01') RETURNING id")
      .get(++n, artistId, title, `https://x.bandcamp.com/album/${n}`, artId, typeof tags === "string" ? tags : JSON.stringify(tags))!.id);
  const track = (albumId: number, duration: number | null) =>
    Number(db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, duration) VALUES (?, ?, 'T', ?) RETURNING id").get(++n, albumId, duration)!.id);
  const play = (trackId: number, when: string, times = 1) => {
    for (let i = 0; i < times; i++) db.raw.prepare("INSERT INTO plays (track_id, played_at, seconds_listened) VALUES (?, ?, 30)").run(trackId, when);
  };
  // 1 Nov 2026, 09:00 in New York.
  const now = () => new Date(2026, 10, 1, 9, 0);

  beforeEach(() => { db = new NodeDb(); });

  it("bounds this month and this year in local time, as stored UTC text", () => {
    expect(periodBounds("month", now())).toEqual({ from: "2026-11-01 04:00:00", to: "2026-12-01 05:00:00" });
    expect(periodBounds("year", now())).toEqual({ from: "2026-01-01 05:00:00", to: "2027-01-01 05:00:00" });
    expect(periodBounds("all", now())).toBeNull();
  });

  it("counts a play in the month it was on the local clock, across a month boundary", async () => {
    const t = track(album(artist("A"), "Album"), 200);
    play(t, "2026-11-01 03:30:00"); // 31 Oct, 23:30 local
    play(t, "2026-11-01 04:30:00"); // 1 Nov, 00:30 local
    play(t, "2026-01-01 03:00:00"); // 31 Dec 2025, 22:00 local
    const month = await listeningStats(db, "month", now());
    const year = await listeningStats(db, "year", now());
    const all = await listeningStats(db, "all", now());
    expect(month.totals).toEqual({ plays: 1, seconds: 200, albums: 1 });
    expect(year.totals).toEqual({ plays: 2, seconds: 400, albums: 1 });
    expect(all.totals).toEqual({ plays: 3, seconds: 600, albums: 1 });
    // In October, the 23:30 play is this month's only one.
    expect((await listeningStats(db, "month", new Date(2026, 9, 15))).totals.plays).toBe(1);
  });

  it("ranks by plays, then time, then name, then id, and keeps the top 10", async () => {
    const a = artist("beta"), b = artist("Alpha"), c = artist("gamma");
    const x = album(a, "x", ["Rock"]), y = album(b, "Y", ["rock", "Ambient"]), z = album(c, "z", ["ambient"]);
    play(track(x, 100), "2026-11-01 12:00:00", 3);
    play(track(y, 100), "2026-11-01 12:00:00", 3);
    play(track(z, 300), "2026-11-01 12:00:00", 1);
    play(track(z, null), "2026-11-01 12:00:00", 2);
    for (let i = 0; i < 12; i++) play(track(album(artist(`Other ${i}`), `Other ${i}`, [`t${i}`]), 10), "2026-11-01 12:00:00");
    const s = await listeningStats(db, "month", now());
    // x, y and z all have 3 plays; z has 300 s (one duration is missing), x and y 300 s too: names decide.
    expect(s.albums.slice(0, 3).map((r) => [r.title, r.plays, r.seconds])).toEqual([["x", 3, 300], ["Y", 3, 300], ["z", 3, 300]]);
    expect(s.artists.slice(0, 3).map((r) => r.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(s.albums).toHaveLength(10);
    expect(s.artists).toHaveLength(10);
    expect(s.albums.slice(3).map((r) => r.title)).toEqual(["Other 0", "Other 1", "Other 10", "Other 11", "Other 2", "Other 3", "Other 4"]);
    // y carries "rock" and "Ambient", counted once each; case variants are one tag.
    expect(s.tags.slice(0, 2).map((r) => [r.tag, r.plays, r.seconds])).toEqual([["Ambient", 6, 600], ["Rock", 6, 600]]);
    expect(s.tags).toHaveLength(10);
    expect(s.totals).toEqual({ plays: 21, seconds: 1020, albums: 15 });
  });

  it("shows each artist and tag with the art of its most played album", async () => {
    const a = artist("A");
    const small = album(a, "Small", ["drone"], 111), big = album(a, "Big", ["drone"], 222);
    play(track(small, 100), "2026-11-01 12:00:00", 1);
    play(track(big, 100), "2026-11-01 12:00:00", 2);
    const s = await listeningStats(db, "all", now());
    expect(s.artists).toEqual([{ artist_id: a, name: "A", plays: 3, seconds: 300, art_id: 222 }]);
    expect(s.tags).toEqual([{ tag: "drone", plays: 3, seconds: 300, art_id: 222 }]);
    expect(s.albums[0]).toEqual({ album_id: big, title: "Big", artist_name: "A", art_id: 222, plays: 2, seconds: 200 });
  });

  it("leaves out albums waiting for their removal, and reads bad tags as none", async () => {
    const a = artist("A");
    const keep = album(a, "Keep", "not json"), gone = album(artist("B"), "Gone", ["x"]);
    play(track(keep, 60), "2026-11-01 12:00:00");
    play(track(gone, 60), "2026-11-01 12:00:00", 5);
    await markRemoving(db, gone);
    const s = await listeningStats(db, "all", now());
    expect(s.albums.map((r) => r.title)).toEqual(["Keep"]);
    expect(s.artists.map((r) => r.name)).toEqual(["A"]);
    expect(s.tags).toEqual([]);
    expect(s.totals).toEqual({ plays: 1, seconds: 60, albums: 1 });
    await unmarkRemoving(db, [gone]);
    expect((await listeningStats(db, "all", now())).albums.map((r) => r.title)).toEqual(["Gone", "Keep"]);
  });

  it("is empty with no plays, and after clearing the history", async () => {
    const empty = { totals: { plays: 0, seconds: 0, albums: 0 }, artists: [], albums: [], tags: [] };
    expect(await listeningStats(db, "all", now())).toEqual(empty);
    play(track(album(artist("A"), "Album"), null), "2026-11-01 12:00:00");
    expect((await listeningStats(db, "month", now())).totals).toEqual({ plays: 1, seconds: 0, albums: 1 });
    await clearPlays(db);
    expect(await listeningStats(db, "month", now())).toEqual(empty);
  });

  // 50k generated plays over 2,000 albums: each statement runs in 1-25 ms (see the PR).
  it("reads a period's plays through ix_plays_played_at and all time through the covering ix_plays_track", () => {
    for (const [bounded, args] of [[true, ["2026-11-01 04:00:00", "2026-12-01 05:00:00", 10]], [false, [10]]] as const) {
      for (const [name, sql] of Object.entries(statsSql(bounded))) {
        const params = name === "totals" ? args.slice(0, -1) : args;
        const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])).map((r) => String(r.detail)).join("\n");
        expect(plan).toMatch(bounded ? /SEARCH p USING INDEX ix_plays_played_at/ : /SEARCH p USING COVERING INDEX ix_plays_track/);
        expect(plan).not.toMatch(/SCAN (p|plays)\b/);
      }
    }
  });
});
