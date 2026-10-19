import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import * as pl from "../src/db/repos/playlists.js";

// Bulk actions on a filtered library can send tens of thousands of track ids at once: past
// SQLite's 500-term compound SELECT and 32,766 bind-variable limits.
let db: NodeDb;
let trackIds: number[];

function seed(n: number) {
  db.raw.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (1, 1, 'A', 'https://a.bandcamp.com')").run();
  db.raw.prepare(`INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (1, 1, 'album', 1, 'Big', 'https://a.bandcamp.com/album/big', '2026-01-01 00:00:00')`).run();
  db.raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
    INSERT INTO tracks (track_id, album_id, title, track_num) SELECT 100000 + i, 1, 'T' || i, i FROM n`);
  trackIds = (db.raw.prepare("SELECT id FROM tracks ORDER BY track_num").all() as { id: number }[]).map((r) => r.id);
}

const positions = (playlistId: number) =>
  (db.raw.prepare("SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlistId) as { track_id: number; position: number }[]);

beforeEach(() => { db = new NodeDb(); seed(40_000); });

describe("playlists with bulk-sized track lists", () => {
  it("adds 600 tracks after existing ones, in order, with consecutive positions", async () => {
    const p = await pl.createPlaylist(db, "Six hundred");
    await pl.addTracks(db, p.id, trackIds.slice(0, 2));
    await pl.addTracks(db, p.id, trackIds.slice(2, 602));
    const rows = positions(p.id);
    expect(rows).toHaveLength(602);
    expect(rows.map((r) => r.track_id)).toEqual(trackIds.slice(0, 602));
    expect(rows.map((r) => r.position)).toEqual([...Array(602).keys()]);
  });

  it("adds 40,000 tracks in one statement", async () => {
    const p = await pl.createPlaylist(db, "Everything");
    await pl.addTracks(db, p.id, trackIds);
    const rows = positions(p.id);
    expect(rows).toHaveLength(40_000);
    expect(rows[0]).toEqual({ track_id: trackIds[0], position: 0 });
    expect(rows[39_999]).toEqual({ track_id: trackIds[39_999], position: 39_999 });
    expect(rows.every((r, i) => r.track_id === trackIds[i] && r.position === i)).toBe(true);
  });

  it("answers playlistsContaining for 40,000 ids", async () => {
    const all = await pl.createPlaylist(db, "All");
    const some = await pl.createPlaylist(db, "Some");
    await pl.addTracks(db, all.id, trackIds);
    await pl.addTracks(db, some.id, trackIds.slice(0, 39_999));
    expect(await pl.playlistsContaining(db, trackIds)).toEqual(new Set([all.id]));
    expect(await pl.playlistsContaining(db, trackIds.slice(0, 39_999))).toEqual(new Set([all.id, some.id]));
    // A repeated id doesn't change the answer.
    expect(await pl.playlistsContaining(db, [trackIds[0], trackIds[0]])).toEqual(new Set([all.id, some.id]));
  });

  it("reorders a 40,000-track playlist", async () => {
    const p = await pl.createPlaylist(db, "Big");
    await pl.addTracks(db, p.id, trackIds);
    const ptids = (db.raw.prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(p.id) as { id: number }[]).map((r) => r.id);
    await pl.reorder(db, p.id, [ptids[39_999], ...ptids.slice(0, 39_999)]);
    const rows = positions(p.id);
    expect(rows[0].track_id).toBe(trackIds[39_999]);
    expect(rows[1].track_id).toBe(trackIds[0]);
    expect(rows.map((r) => r.position)).toEqual([...Array(40_000).keys()]);
  });

  it("reorder leaves other playlists' rows alone", async () => {
    const a = await pl.createPlaylist(db, "A");
    const b = await pl.createPlaylist(db, "B");
    await pl.addTracks(db, a.id, trackIds.slice(0, 2));
    await pl.addTracks(db, b.id, trackIds.slice(0, 2));
    const bIds = (db.raw.prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(b.id) as { id: number }[]).map((r) => r.id);
    await pl.reorder(db, a.id, [...bIds].reverse()); // ids from another playlist: no effect
    expect(positions(b.id).map((r) => r.track_id)).toEqual(trackIds.slice(0, 2));
  });
});
