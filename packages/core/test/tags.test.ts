import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { listAlbums, listAlbumTracks, listTags } from "../src/db/repos/albums.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { fixture } from "./helpers.js";

let db: NodeDb;
let nextId = 1;

function artist(name: string): number {
  const id = nextId++;
  db.raw.prepare("INSERT INTO artists (id, band_id, name, url) VALUES (?, ?, ?, ?)").run(id, id, name, `https://a${id}.bandcamp.com`);
  return id;
}

function album(artistId: number, title: string, tags: string[], o: { owned?: boolean; tracks?: string[]; created?: string } = {}): number {
  const id = nextId++;
  db.raw.prepare(
    `INSERT INTO albums (id, bandcamp_id, item_type, artist_id, title, url, tags_json, owned, fetched_at, created_at)
     VALUES (?, ?, 'album', ?, ?, ?, ?, ?, '2026-01-01 00:00:00', ?)`,
  ).run(id, id, artistId, title, `https://x.bandcamp.com/album/${id}`, JSON.stringify(tags), o.owned ? 1 : 0, o.created ?? `2026-01-${String(id).padStart(2, "0")} 00:00:00`);
  (o.tracks ?? ["One"]).forEach((t, i) => {
    db.raw.prepare("INSERT INTO tracks (track_id, album_id, title, track_num) VALUES (?, ?, ?, ?)").run(id * 100 + i, id, t, i + 1);
  });
  return id;
}

const titles = async (...args: Parameters<typeof listAlbums> extends [unknown, ...infer R] ? R : never) => (await listAlbums(db, ...args)).map((a) => a.title);

let ids: Record<string, number>;
beforeEach(() => {
  db = new NodeDb();
  nextId = 1;
  const a = artist("Aphex");
  const b = artist("Boards");
  ids = {
    drift: album(a, "Drift", ["Electronic", "ambient", "électronique"], { owned: true, tracks: ["Haze", "Tide"] }),
    pulse: album(a, "Pulse", ["electronic", "techno"]),
    calm: album(b, "Calm", ["Ambient", "electronique"], { tracks: ["Haze Two"] }),
    bare: album(b, "Bare", []),
  };
});

describe("listTags (#71)", () => {
  it("counts library albums per tag, most used first, folding ASCII case only", async () => {
    expect(await listTags(db)).toEqual([
      // "Electronic" (Drift) and "electronic" (Pulse) are one tag shown in its first-sorting form.
      { tag: "Ambient", album_count: 2 },
      { tag: "Electronic", album_count: 2 },
      // Diacritics are kept as stored: two different tags.
      { tag: "electronique", album_count: 1 },
      { tag: "techno", album_count: 1 },
      { tag: "électronique", album_count: 1 },
    ]);
  });

  it("counts an album once even when it lists a tag in two spellings", async () => {
    album(artist("C"), "Twice", ["Rock", "rock"]);
    expect((await listTags(db)).find((t) => t.tag === "Rock")).toEqual({ tag: "Rock", album_count: 1 });
  });

  it("follows the Show filter", async () => {
    expect(await listTags(db, "purchased")).toEqual([
      { tag: "ambient", album_count: 1 },
      { tag: "Electronic", album_count: 1 },
      { tag: "électronique", album_count: 1 },
    ]);
  });

  it("skips blank and non-text entries", async () => {
    album(artist("D"), "Odd", ["  ", "", "jazz"]);
    db.raw.prepare("UPDATE albums SET tags_json = '[3, null, \"jazz\"]' WHERE id = ?").run(ids.bare);
    expect((await listTags(db)).filter((t) => t.tag.trim() === "" || t.tag === "3")).toEqual([]);
    expect((await listTags(db)).find((t) => t.tag === "jazz")?.album_count).toBe(2);
  });

  it("is empty for an empty library", async () => {
    db = new NodeDb();
    expect(await listTags(db)).toEqual([]);
  });
});

describe("listAlbums by tag (#71)", () => {
  it("matches the tag regardless of ASCII case, but not across diacritics", async () => {
    expect(await titles("title", "all", "", "ambient")).toEqual(["Calm", "Drift"]);
    expect(await titles("title", "all", "", "ELECTRONIC")).toEqual(["Drift", "Pulse"]);
    expect(await titles("title", "all", "", "électronique")).toEqual(["Drift"]);
    expect(await titles("title", "all", "", "electronique")).toEqual(["Calm"]);
    expect(await titles("title", "all", "", "nope")).toEqual([]);
  });

  it("matches whole tags, not substrings or LIKE patterns", async () => {
    expect(await titles("title", "all", "", "amb")).toEqual([]);
    expect(await titles("title", "all", "", "%")).toEqual([]);
  });

  it("combines with the Show filter, the filter text and every sort", async () => {
    expect(await titles("title", "purchased", "", "ambient")).toEqual(["Drift"]);
    expect(await titles("title", "all", "haze", "ambient")).toEqual(["Calm", "Drift"]);
    expect(await titles("title", "all", "two", "ambient")).toEqual(["Calm"]);
    expect(await titles("added", "all", "", "ambient")).toEqual(["Calm", "Drift"]);
    expect(await titles("artist", "all", "", "ambient")).toEqual(["Drift", "Calm"]);
  });

  it("an empty tag changes nothing", async () => {
    expect(await titles("title", "all", "", "  ")).toEqual(await titles("title"));
  });

  it("bulk tracks follow the tag, in grid order", async () => {
    const tracks = await listAlbumTracks(db, "title", "all", "", "ambient");
    expect(tracks.map((t) => t.title)).toEqual(["Haze Two", "Haze", "Tide"]);
  });
});

describe("tags from an import", () => {
  it("are stored from the page's ld+json keywords and listed", async () => {
    const parsed = parseTralbumPage(fixture("album"));
    const id = await upsertTralbum(db, parsed);
    const tags = await listTags(db);
    expect(parsed.tags.length).toBeGreaterThan(0);
    for (const t of parsed.tags) expect(tags.some((x) => x.tag.toLowerCase() === t.toLowerCase())).toBe(true);
    expect((await listAlbums(db, "added", "all", "", parsed.tags[0])).map((a) => a.id)).toContain(id);
  });
});
