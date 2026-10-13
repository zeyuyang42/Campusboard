import { describe, it, expect } from "vitest";
import { parseMusicPage } from "../src/scrape/parseMusic.js";
import { fixture } from "./helpers.js";

const ORIGIN = "https://illuminatihotties.bandcamp.com";

describe("parseMusicPage", () => {
  it("collects album and track links from the music grid", () => {
    const m = parseMusicPage(fixture("music"), ORIGIN);
    expect(m.items.length).toBe(20);
    expect(m.items[0]).toBe(`${ORIGIN}/album/free-i-h-five-years-free`);
    expect(m.items).toContain(`${ORIGIN}/track/777`);
    expect(new Set(m.items).size).toBe(m.items.length);
    expect(m.band).toEqual({ band_id: 2304999462, name: "illuminati hotties" });
  });
  it("merges data-client-items and dedupes", () => {
    const html =
      `<html><ol id="music-grid"><li><a href="/album/a">A</a></li><li><a href="/album/a">A again</a></li></ol>` +
      `<div data-client-items="[{&quot;page_url&quot;:&quot;https://other.bandcamp.com/album/b&quot;},{&quot;page_url&quot;:&quot;/track/c?x=1&quot;}]"></div></html>`;
    const m = parseMusicPage(html, "https://x.bandcamp.com");
    expect(m.items).toEqual(["https://x.bandcamp.com/album/a", "https://other.bandcamp.com/album/b", "https://x.bandcamp.com/track/c"]);
  });
  it("throws parse_failed on an empty page", () => {
    expect(() => parseMusicPage("<html></html>", ORIGIN)).toThrow(/No discography/);
  });
});
