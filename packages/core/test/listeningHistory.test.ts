import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { PlayCounter, playThreshold, PLAY_MAX_THRESHOLD_SEC } from "../src/services/playRule.js";
import { recordPlay, recentlyPlayedAlbums, mostPlayedAlbums, countPlays, clearPlays } from "../src/db/repos/plays.js";
import { listAlbums, getAlbumWithTracks, deleteAlbum, ALBUM_SORTS } from "../src/db/repos/albums.js";
import { searchTracks } from "../src/db/repos/tracks.js";
import { createPlaylist, addTracks, getPlaylist } from "../src/db/repos/playlists.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";

/** Feed playhead positions from `from` to `to` in quarter-second steps, as timeupdate would. */
function listen(c: PlayCounter, from: number, to: number, step = 0.25) {
  const hits = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const h = c.progress(t);
    if (h) hits.push(h);
  }
  return hits;
}

describe("playThreshold", () => {
  it("is half the track, capped at four minutes", () => {
    expect(playThreshold(200)).toBe(100);
    expect(playThreshold(480)).toBe(PLAY_MAX_THRESHOLD_SEC);
    expect(playThreshold(3600)).toBe(240);
  });
  it("never counts tracks of 30 seconds or less, or of unknown length", () => {
    expect(playThreshold(30)).toBeNull();
    expect(playThreshold(12)).toBeNull();
    expect(playThreshold(30.5)).toBeCloseTo(15.25);
    expect(playThreshold(null)).toBeNull();
    expect(playThreshold(Number.NaN)).toBeNull();
    expect(playThreshold(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("PlayCounter", () => {
  let c: PlayCounter;
  beforeEach(() => { c = new PlayCounter(); });

  it("counts once, when listened time reaches the threshold", () => {
    c.start(7, 200);
    expect(listen(c, 0, 99.5)).toEqual([]);
    const hits = listen(c, 99.75, 200);
    expect(hits).toHaveLength(1);
    expect(hits[0].trackId).toBe(7);
    expect(hits[0].seconds).toBeGreaterThanOrEqual(100);
  });

  it("caps the threshold at four minutes for long tracks", () => {
    c.start(1, 600);
    expect(listen(c, 0, 239.5)).toEqual([]);
    expect(listen(c, 239.75, 241)).toHaveLength(1);
  });

  it("ignores tracks of 30 seconds or less", () => {
    c.start(1, 30);
    expect(listen(c, 0, 30)).toEqual([]);
  });

  it("does nothing before the first playback", () => {
    expect(listen(c, 0, 500)).toEqual([]);
  });

  it("does not count seeking ahead (announced or not)", () => {
    c.start(1, 200);
    listen(c, 0, 10);
    c.seeked();
    listen(c, 150, 160); // 10 s more after a seek: 20 s listened
    expect(c.listenedSeconds).toBeCloseTo(20);
    // A jump without a seek notice is ignored too.
    expect(c.progress(190)).toBeNull();
    expect(c.listenedSeconds).toBeCloseTo(20);
  });

  it("does not count seeking backwards, but keeps what was listened", () => {
    c.start(1, 200);
    listen(c, 0, 60);
    c.seeked();
    expect(listen(c, 0, 39.5)).toEqual([]); // 60 + 39.5 < 100
    expect(listen(c, 39.75, 41)).toHaveLength(1); // listening again counts as listening
  });

  it("keeps listened time across a pause", () => {
    c.start(1, 200);
    listen(c, 0, 60);
    // Paused: no progress reports. Resuming continues from the same position.
    expect(listen(c, 60, 99.5)).toEqual([]);
    expect(listen(c, 99.75, 100.5)).toHaveLength(1);
  });

  it("counts each fresh playback once (repeat-one, replay, Previous)", () => {
    c.start(1, 100);
    expect(listen(c, 0, 100)).toHaveLength(1);
    // Repeat-one / play again: same track, a new playback.
    c.start(1, 100);
    expect(listen(c, 0, 100)).toHaveLength(1);
    // Seeking back to the start within one playback doesn't make it fresh.
    c.seeked();
    expect(listen(c, 0, 100)).toEqual([]);
  });

  it("starting another track before the threshold drops the first one", () => {
    c.start(1, 200);
    listen(c, 0, 90);
    c.start(2, 200);
    const hits = listen(c, 0, 100);
    expect(hits.map((h) => h.trackId)).toEqual([2]);
  });

  it("uses the media element's duration when it arrives", () => {
    c.start(1, null);
    listen(c, 0, 20);
    c.setDuration(40);
    expect(listen(c, 20.25, 21)).toHaveLength(1);
    c.start(2, 200);
    c.setDuration(Number.NaN); // ignored
    expect(listen(c, 0, 99.5)).toEqual([]);
  });

  it("counts fast playback (high playbackRate) by playhead progress", () => {
    c.start(1, 200);
    expect(listen(c, 0, 101, 4)).toHaveLength(1); // 4 s of media per report
  });
});

describe("plays repo", () => {
  let db: NodeDb;
  let albumId: number;
  let trackIds: number[];
  const at = (id: number, when: string) => db.raw.prepare("UPDATE plays SET played_at = ? WHERE id = ?").run(when, id);

  beforeEach(async () => {
    db = new NodeDb();
    albumId = await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
    trackIds = (await getAlbumWithTracks(db, albumId))!.tracks.map((t) => t.id);
  });

  async function otherAlbum(title: string) {
    db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (99, 'Other', 'https://other.bandcamp.com')").run();
    const ar = Number(db.raw.prepare("SELECT id FROM artists WHERE band_id = 99").get()!.id);
    const al = Number(db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (1, 'album', ?, ?, 'https://other.bandcamp.com/album/x', '2026-01-01') RETURNING id").get(ar, title)!.id);
    const t = Number(db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, duration) VALUES (1, ?, 'Other track', 200) RETURNING id").get(al)!.id);
    return { al, t };
  }

  it("records a play as one row and refuses a track that is gone", async () => {
    const id = await recordPlay(db, trackIds[0], 101.3);
    expect(id).toBeGreaterThan(0);
    expect(await countPlays(db)).toBe(1);
    expect(await recordPlay(db, 999_999, 100)).toBeNull();
    expect(await countPlays(db)).toBe(1);
    const row = db.raw.prepare("SELECT track_id, seconds_listened, played_at FROM plays").get()!;
    expect(row.track_id).toBe(trackIds[0]);
    expect(row.seconds_listened).toBeCloseTo(101.3);
    expect(String(row.played_at)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("shows play counts on track rows everywhere (album, Tracks tab, playlists)", async () => {
    await recordPlay(db, trackIds[1], 100);
    await recordPlay(db, trackIds[1], 100);
    const album = (await getAlbumWithTracks(db, albumId))!;
    expect(album.tracks[1].play_count).toBe(2);
    expect(album.tracks[0].play_count).toBe(0);
    expect(album.play_count).toBe(2);
    const tr = (await searchTracks(db, "")).find((t) => t.id === trackIds[1])!;
    expect(tr.play_count).toBe(2);
    const pl = await createPlaylist(db, "p");
    await addTracks(db, pl.id, [trackIds[1]]);
    expect((await getPlaylist(db, pl.id))!.tracks[0].play_count).toBe(2);
  });

  it("lists recently and most played albums", async () => {
    const other = await otherAlbum("Other album");
    at((await recordPlay(db, trackIds[0], 100))!, "2026-10-01 10:00:00");
    at((await recordPlay(db, trackIds[2], 100))!, "2026-10-01 11:00:00");
    at((await recordPlay(db, other.t, 100))!, "2026-10-02 09:00:00");
    const recent = await recentlyPlayedAlbums(db);
    expect(recent.map((a) => a.id)).toEqual([other.al, albumId]);
    expect(recent[1].play_count).toBe(2);
    expect(recent[1].last_played_at).toBe("2026-10-01 11:00:00");
    expect((await mostPlayedAlbums(db)).map((a) => a.id)).toEqual([albumId, other.al]);
    expect((await mostPlayedAlbums(db, 1)).map((a) => a.id)).toEqual([albumId]);
  });

  it("breaks same-second ties by the later play", async () => {
    const other = await otherAlbum("Other album");
    at((await recordPlay(db, trackIds[0], 100))!, "2026-10-01 10:00:00");
    at((await recordPlay(db, other.t, 100))!, "2026-10-01 10:00:00");
    expect((await recentlyPlayedAlbums(db)).map((a) => a.id)).toEqual([other.al, albumId]);
  });

  it("sorts the library by recently and most played, never-played albums last", async () => {
    expect(ALBUM_SORTS).toContain("played");
    expect(ALBUM_SORTS).toContain("plays");
    const a = await otherAlbum("Played once, later");
    db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (98, 'Third', 'https://third.bandcamp.com')").run();
    const ar = Number(db.raw.prepare("SELECT id FROM artists WHERE band_id = 98").get()!.id);
    const never = Number(db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (2, 'album', ?, 'Never played', 'https://third.bandcamp.com/album/n', '2026-01-01') RETURNING id").get(ar)!.id);
    at((await recordPlay(db, trackIds[0], 100))!, "2026-10-01 10:00:00");
    at((await recordPlay(db, trackIds[1], 100))!, "2026-10-01 10:05:00");
    at((await recordPlay(db, a.t, 100))!, "2026-10-03 10:00:00");
    expect((await listAlbums(db, "played")).map((x) => x.id)).toEqual([a.al, albumId, never]);
    expect((await listAlbums(db, "plays")).map((x) => x.id)).toEqual([albumId, a.al, never]);
    expect((await listAlbums(db, "plays")).map((x) => x.play_count)).toEqual([2, 1, 0]);
  });

  it("deleting an album removes its plays", async () => {
    await recordPlay(db, trackIds[0], 100);
    const other = await otherAlbum("Other album");
    await recordPlay(db, other.t, 100);
    await deleteAlbum(db, albumId);
    expect(db.raw.prepare("SELECT track_id FROM plays").all().map((r) => r.track_id)).toEqual([other.t]);
  });

  it("a re-import that drops a track removes that track's plays", async () => {
    await recordPlay(db, trackIds[0], 100);
    await recordPlay(db, trackIds[1], 100);
    const p = parseTralbumPage(fixture("album"), 0);
    p.tracks = p.tracks.slice(1);
    await upsertTralbum(db, p);
    expect(db.raw.prepare("SELECT track_id FROM plays").all().map((r) => r.track_id)).toEqual([trackIds[1]]);
  });

  it("keeps plays when a single track moves into its album", async () => {
    const fresh = new NodeDb();
    await upsertTralbum(fresh, parseTralbumPage(fixture("track"), 0));
    const single = (await searchTracks(fresh, ""))[0];
    await recordPlay(fresh, single.id, 100);
    await upsertTralbum(fresh, parseTralbumPage(fixture("album"), 0));
    await vacuumOrphans(fresh);
    expect(await countPlays(fresh)).toBe(1);
    expect((await recentlyPlayedAlbums(fresh))[0].item_type).toBe("album");
  });

  it("vacuumOrphans sweeps plays left by deletes made with foreign keys off", async () => {
    await recordPlay(db, trackIds[0], 100);
    await recordPlay(db, trackIds[1], 100);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.raw.prepare("DELETE FROM tracks WHERE id = ?").run(trackIds[0]);
    db.raw.exec("PRAGMA foreign_keys = ON");
    expect(await countPlays(db)).toBe(2);
    await vacuumOrphans(db);
    expect(db.raw.prepare("SELECT track_id FROM plays").all().map((r) => r.track_id)).toEqual([trackIds[1]]);
  });

  it("clears the history", async () => {
    await recordPlay(db, trackIds[0], 100);
    await recordPlay(db, trackIds[1], 100);
    expect(await clearPlays(db)).toBe(2);
    expect(await countPlays(db)).toBe(0);
    expect(await recentlyPlayedAlbums(db)).toEqual([]);
  });
});
