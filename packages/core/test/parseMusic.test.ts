import { describe, it, expect } from "vitest";
import { parseMusicPage } from "../src/scrape/parseMusic.js";
import { fixture } from "./helpers.js";

const ORIGIN = "https://illuminatihotties.bandcamp.com";

describe("parseMusicPage", () => {
  it("collects album and track links from the music grid", () => {
    const m = parseMusicPage(fixture("music"), ORIGIN);
    expect(m.items.length).toBe(20);
    expect(m.items[0]).toEqual({ url: `${ORIGIN}/album/free-i-h-five-years-free`, item_type: "album", title: "FREE I.H: Five Years Free", art_id: 3058667025, artist: null });
    const t = m.items.find((i) => i.url === `${ORIGIN}/track/777`);
    expect(t).toMatchObject({ item_type: "track", title: "777", art_id: 595042629 });
    expect(new Set(m.items.map((i) => i.url)).size).toBe(m.items.length);
    expect(m.band).toEqual({ band_id: 2304999462, name: "illuminati hotties" });
  });
  it("merges data-client-items, keeps label artists and dedupes", () => {
    const html =
      `<html><div data-band="{}"></div><ol id="music-grid"><li class="music-grid-item"><a href="/album/a"><div class="art"><img src="https://f4.bcbits.com/img/a0000000042_2.jpg"></div><p class="title">A<span class="artist-override">Some Band</span></p></a></li>` +
      `<li class="music-grid-item"><a href="/album/a"><p class="title">A again</p></a></li></ol>` +
      `<div data-client-items="[{&quot;page_url&quot;:&quot;https://other.bandcamp.com/album/b?label=1&quot;,&quot;title&quot;:&quot;B &amp;amp; more&quot;,&quot;art_id&quot;:7,&quot;artist&quot;:&quot;Other&quot;,&quot;type&quot;:&quot;album&quot;},{&quot;page_url&quot;:&quot;/track/c?x=1&quot;}]"></div></html>`;
    const m = parseMusicPage(html, "https://x.bandcamp.com");
    expect(m.items).toEqual([
      { url: "https://x.bandcamp.com/album/a", item_type: "album", title: "A", art_id: 42, artist: "Some Band" },
      { url: "https://other.bandcamp.com/album/b", item_type: "album", title: "B & more", art_id: 7, artist: "Other" },
      { url: "https://x.bandcamp.com/track/c", item_type: "track", title: "c", art_id: null, artist: null },
    ]);
  });
  it("throws parse_failed on a Bandcamp page with no releases", () => {
    expect(() => parseMusicPage(`<html><div data-band="{}"></div></html>`, ORIGIN)).toThrow(/No discography/);
  });
  it("throws not_bandcamp when the page has no Bandcamp data at all", () => {
    expect(() => parseMusicPage("<html></html>", ORIGIN)).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
  });
});
