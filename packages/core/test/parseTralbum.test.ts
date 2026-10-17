import { describe, it, expect } from "vitest";
import { parseTralbumPage, streamExpiry } from "../src/scrape/parseTralbum.js";
import { decodeEntities } from "../src/scrape/html.js";
import { ScrapeError } from "../src/scrape/errors.js";
import { fixture } from "./helpers.js";

describe("parseTralbumPage", () => {
  it("parses an album page", () => {
    const a = parseTralbumPage(fixture("album"), 0);
    expect(a.item_type).toBe("album");
    expect(a.bandcamp_id).toBe(3637872805);
    expect(a.title).toBe("Let Me Do One More");
    expect(a.artist).toEqual({ band_id: 2304999462, name: "illuminati hotties", url: "https://illuminatihotties.bandcamp.com" });
    expect(a.art_id).toBe(872064409);
    expect(a.tracks).toHaveLength(12);
    expect(a.tags).toContain("tenderpunk");
    expect(a.parent_album_id).toBeNull();
    const t = a.tracks[0];
    expect(t.track_id).toBe(282506895);
    expect(t.track_num).toBe(1);
    expect(t.duration).toBeGreaterThan(100);
    expect(t.streamable).toBe(true);
    expect(t.stream_url).toMatch(/^https:\/\/t4\.bcbits\.com\/stream\/.*\/mp3-128\//);
    expect(t.stream_expires_at).toBe(1791985620 * 1000);
    expect(a.tracks.every((x) => x.title.length > 0)).toBe(true);
  });
  it("parses a single track page and links its parent album", () => {
    const t = parseTralbumPage(fixture("track"), 0);
    expect(t.item_type).toBe("track");
    expect(t.bandcamp_id).toBe(282506895);
    expect(t.title).toBe("Pool Hopping");
    expect(t.parent_album_id).toBe(3637872805);
    expect(t.tracks).toHaveLength(1);
    expect(t.tracks[0].streamable).toBe(true);
  });
  it("raises client_challenge on a challenge page", () => {
    expect(() => parseTralbumPage(fixture("challenge"))).toThrowError(ScrapeError);
    try {
      parseTralbumPage(fixture("challenge"));
    } catch (e) {
      expect((e as ScrapeError).code).toBe("client_challenge");
    }
  });
  it("raises parse_failed when data-tralbum is missing or malformed", () => {
    expect(() => parseTralbumPage('<html><title>x</title><div data-band="{}"></div></html>')).toThrow(/No data-tralbum/);
    expect(() => parseTralbumPage("<html><title>x</title></html>")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => parseTralbumPage('<html><script data-tralbum="{&quot;id&quot;:1}"></script></html>')).toThrow(/schema mismatch/);
  });
  it("marks tracks without a file as not streamable", () => {
    const html = fixture("album").replace(/&quot;file&quot;:\{&quot;mp3-128&quot;:&quot;.*?&quot;\}/, "&quot;file&quot;:null");
    const a = parseTralbumPage(html, 0);
    const dead = a.tracks.filter((t) => !t.streamable);
    expect(dead).toHaveLength(1);
    expect(dead[0].stream_url).toBeNull();
    expect(dead[0].stream_expires_at).toBeNull();
  });
});

describe("helpers", () => {
  it("decodes entities", () => {
    expect(decodeEntities("a &amp; b &quot;c&quot; &#39;d&#39; &#x27;e&#x27; &lt;f&gt;")).toBe(`a & b "c" 'd' 'e' <f>`);
  });
  it("derives stream expiry from ts or falls back to +24h", () => {
    expect(streamExpiry("https://x/y?p=0&ts=1700000000&t=z", 5)).toBe(1700000000000);
    expect(streamExpiry("https://x/y", 5)).toBe(5 + 86400000);
  });
});
