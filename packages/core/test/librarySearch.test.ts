import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { likeContains } from "../src/db/Db.js";
import { listAlbums, ALBUM_SORTS } from "../src/db/repos/albums.js";
import { searchTracks } from "../src/db/repos/tracks.js";
import { getArtist } from "../src/db/repos/artists.js";

let db: NodeDb;
let nextId = 1;

function artist(name: string): number {
  const id = nextId++;
  db.raw.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (?, ?, ?, ?)").run(id, id, name, `https://a${id}.bandcamp.com`);
  return id;
}

function album(artistId: number, title: string, o: { release?: string | null; created?: string; owned?: boolean; tracks?: string[]; trackArtist?: string } = {}): number {
  const id = nextId++;
  db.raw.prepare(
    `INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, release_date, owned, fetched_at, created_at)
     VALUES (?, ?, 'album', ?, ?, ?, ?, ?, '2026-01-01 00:00:00', ?)`,
  ).run(id, id, artistId, title, `https://x.bandcamp.com/album/${id}`, o.release ?? null, o.owned ? 1 : 0, o.created ?? `2026-01-${String(id).padStart(2, "0")} 00:00:00`);
  (o.tracks ?? []).forEach((t, i) => {
    db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, track_num, track_artist) VALUES (?, ?, ?, ?, ?)").run(id * 100 + i, id, t, i + 1, o.trackArtist ?? null);
  });
  return id;
}

function wishlist(albumId: number) {
  db.raw.prepare("INSERT INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, sync_job) VALUES ('wishlist', 'album', ?, '', '', 1)").run(albumId);
}

const titles = async (...args: Parameters<typeof listAlbums> extends [unknown, ...infer R] ? R : never) => (await listAlbums(db, ...args)).map((a) => a.title);

let ids: Record<string, number>;
beforeEach(() => {
  db = new NodeDb();
  nextId = 1;
  const hotties = artist("illuminati hotties");
  const keating = artist("Zoë Keating");
  const boards = artist("Boards of Canada");
  ids = {
    lmdom: album(hotties, "Let Me Do One More", { release: "01 Oct 2021 00:00:00 GMT", owned: true, tracks: ["Pool Hopping", "MMMOOOAAAAAYAYA"] }),
    kiss: album(hotties, "Kiss Yr Frenemies", { release: "11 May 2018 00:00:00 GMT", tracks: ["Paying Off The Happiness"] }),
    snowmelt: album(keating, "Snowmelt EP", { release: "28 Jun 2018 00:00:00 GMT", tracks: ["Sun_Rise", "100% Rain"] }),
    music: album(boards, "Music Has the Right to Children", { release: "20 Apr 1998 00:00:00 GMT", tracks: ["Roygbiv", "Aquarius"] }),
    comp: album(boards, "a compilation", { release: null, tracks: ["Opener"], trackArtist: "Guest Player" }),
  };
  wishlist(ids.kiss);
  wishlist(ids.snowmelt);
});

describe("likeContains", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(likeContains("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });
});

describe("listAlbums filter", () => {
  it("matches album title, artist name, track titles and track artists, case-insensitively", async () => {
    expect(await titles("title", "all", "snowMELT")).toEqual(["Snowmelt EP"]);
    expect(await titles("title", "all", "HOTTIES")).toEqual(["Kiss Yr Frenemies", "Let Me Do One More"]);
    expect(await titles("title", "all", "pool hop")).toEqual(["Let Me Do One More"]);
    expect(await titles("title", "all", "happiness")).toEqual(["Kiss Yr Frenemies"]);
    expect(await titles("title", "all", "guest")).toEqual(["a compilation"]);
    expect(await titles("title", "all", "no such thing")).toEqual([]);
  });

  it("returns one row per album however many tracks match", async () => {
    expect(await titles("title", "all", "a")).toHaveLength(5);
  });

  it("ignores surrounding whitespace and treats a blank query as no filter", async () => {
    expect(await titles("title", "all", "   ")).toHaveLength(5);
    expect(await titles("title", "all", "  roygbiv ")).toEqual(["Music Has the Right to Children"]);
  });

  it("treats % and _ literally", async () => {
    expect(await titles("title", "all", "%")).toEqual(["Snowmelt EP"]); // "100% Rain"
    expect(await titles("title", "all", "_")).toEqual(["Snowmelt EP"]); // "Sun_Rise"
    expect(await titles("title", "all", "n_r")).toEqual(["Snowmelt EP"]);
    expect(await titles("title", "all", "o%e")).toEqual([]); // would match "One More" etc. unescaped
    expect(await titles("title", "all", "\\")).toEqual([]);
  });

  it("keeps non-ASCII text matchable as typed", async () => {
    expect(await titles("title", "all", "Zoë")).toEqual(["Snowmelt EP"]);
  });

  it("combines with the purchased and wishlist filters", async () => {
    expect(await titles("title", "purchased", "hotties")).toEqual(["Let Me Do One More"]);
    expect(await titles("title", "wishlist", "hotties")).toEqual(["Kiss Yr Frenemies"]);
    expect(await titles("title", "wishlist", "rain")).toEqual(["Snowmelt EP"]);
    expect(await titles("title", "purchased", "rain")).toEqual([]);
    expect(await titles("title", "wishlist", "")).toEqual(["Kiss Yr Frenemies", "Snowmelt EP"]);
  });
});

describe("listAlbums sort", () => {
  it("offers date added first", () => {
    expect(ALBUM_SORTS[0]).toBe("added");
  });
  it("date added: newest first", async () => {
    expect(await titles("added")).toEqual(["a compilation", "Music Has the Right to Children", "Snowmelt EP", "Kiss Yr Frenemies", "Let Me Do One More"]);
  });
  it("artist: by name ignoring case, newest release first within an artist", async () => {
    expect(await titles("artist")).toEqual(["Music Has the Right to Children", "a compilation", "Let Me Do One More", "Kiss Yr Frenemies", "Snowmelt EP"]);
  });
  it("album title: ignoring case", async () => {
    expect(await titles("title")).toEqual(["a compilation", "Kiss Yr Frenemies", "Let Me Do One More", "Music Has the Right to Children", "Snowmelt EP"]);
  });
  it("release date: by actual date (not the stored text), newest first, unknown last", async () => {
    // As text, "28 Jun 2018" > "20 Apr 1998" > "11 May 2018" > "01 Oct 2021".
    expect(await titles("release")).toEqual(["Let Me Do One More", "Snowmelt EP", "Kiss Yr Frenemies", "Music Has the Right to Children", "a compilation"]);
  });
  it("applies the sort to filtered results", async () => {
    expect(await titles("release", "all", "hotties")).toEqual(["Let Me Do One More", "Kiss Yr Frenemies"]);
  });
  it("falls back to date added for an unknown sort", async () => {
    expect(await titles("bogus" as never)).toEqual(await titles("added"));
  });
});

describe("getArtist", () => {
  it("lists an artist's releases by actual release date, newest first", async () => {
    const hotties = (await listAlbums(db)).find((a) => a.title === "Kiss Yr Frenemies")!.artist_id;
    album(hotties, "Early EP", { release: "30 Dec 2016 00:00:00 GMT" });
    // As text, "30 Dec 2016" would sort first.
    expect((await getArtist(db, hotties))!.albums.map((a) => a.title)).toEqual(["Let Me Do One More", "Kiss Yr Frenemies", "Early EP"]);
  });
});

describe("searchTracks", () => {
  it("matches a track's own artist, like the Albums filter", async () => {
    expect((await searchTracks(db, "guest player")).map((t) => t.title)).toEqual(["Opener"]);
  });
  it("escapes wildcards too", async () => {
    expect((await searchTracks(db, "%")).map((t) => t.title)).toEqual(["100% Rain"]);
    expect((await searchTracks(db, "_")).map((t) => t.title)).toEqual(["Sun_Rise"]);
  });
});
