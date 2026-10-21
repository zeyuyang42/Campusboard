import { describe, it, expect } from "vitest";
import { DISCOVER_MAX_TAGS } from "../src/scrape/discover.js";
import { DISCOVER_GENRES, DISCOVER_SUBGENRES, discoverSubgenres, isDiscoverGenre, selectedGenre, toggleTag, withGenre } from "../src/scrape/discoverGenres.js";

const full = Array.from({ length: DISCOVER_MAX_TAGS }, (_, i) => `t${i}`);

describe("discover genres and subgenres", () => {
  it("has Bandcamp's 27 genres and 237 subgenres, each slug a tag norm name", () => {
    expect(DISCOVER_GENRES).toHaveLength(27);
    expect(DISCOVER_SUBGENRES).toHaveLength(237);
    const genres = new Set(DISCOVER_GENRES.map((g) => g.slug));
    expect(genres.size).toBe(27);
    for (const x of [...DISCOVER_GENRES, ...DISCOVER_SUBGENRES]) {
      expect(x.slug).toMatch(/^[^\sA-Z,+/&]+$/);
      expect(x.slug.length).toBeLessThanOrEqual(64);
      expect(x.label.length).toBeGreaterThan(0);
    }
    for (const s of DISCOVER_SUBGENRES) expect(genres.has(s.genre)).toBe(true);
    for (const g of DISCOVER_GENRES) {
      const subs = discoverSubgenres(g.slug).map((s) => s.slug);
      expect(subs.length > 0).toBe(g.slug !== "podcasts" && g.slug !== "audiobooks");
      expect(new Set(subs).size).toBe(subs.length);
    }
    expect(DISCOVER_GENRES.find((g) => g.slug === "hip-hop-rap")?.label).toBe("hip-hop/rap");
    expect(DISCOVER_GENRES.find((g) => g.slug === "r-b-soul")?.label).toBe("r&b/soul");
    expect(discoverSubgenres("electronic").find((s) => s.slug === "drum-bass")?.label).toBe("drum & bass");
    expect(discoverSubgenres(null)).toEqual([]);
  });

  it("treats the first genre tag as the selected genre", () => {
    expect(selectedGenre(["glitch", "electronic", "jazz"])).toBe("electronic");
    expect(selectedGenre(["glitch"])).toBeNull();
    expect(isDiscoverGenre("electronic")).toBe(true);
    expect(isDiscoverGenre("breaks")).toBe(false);
  });

  it("keeps genres exclusive: a new genre replaces the old one and its subgenres", () => {
    expect(withGenre([], "electronic")).toEqual(["electronic"]);
    expect(withGenre(["electronic", "breaks", "glitch", "berlin"], "jazz")).toEqual(["jazz", "berlin"]);
    expect(withGenre(["berlin", "electronic", "folk"], "rock")).toEqual(["rock", "berlin"]);
    expect(withGenre(["electronic", "breaks", "berlin"], null)).toEqual(["berlin"]);
    expect(withGenre(["electronic", "breaks"], "electronic")).toEqual(["electronic", "breaks"]);
    // acoustic's "rock" subgenre is a genre too.
    expect(withGenre(["acoustic", "rock"], "rock")).toEqual(["rock"]);
    expect(withGenre(["x"], "not-a-genre")).toEqual(["x"]);
    expect(withGenre(full, "jazz")).toEqual(["jazz", ...full.slice(0, -1)]);
  });

  it("toggles a subgenre on and off, within the tag limit", () => {
    expect(toggleTag(["electronic"], "breaks")).toEqual(["electronic", "breaks"]);
    expect(toggleTag(["electronic", "breaks"], "breaks")).toEqual(["electronic"]);
    expect(toggleTag(full, "breaks")).toEqual(full);
  });
});
