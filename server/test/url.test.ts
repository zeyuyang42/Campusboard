import { describe, it, expect } from "vitest";
import { normalizeBandcampUrl } from "../src/scrape/url.js";

describe("normalizeBandcampUrl", () => {
  it("classifies album, track and artist URLs", () => {
    expect(normalizeBandcampUrl("https://foo.bandcamp.com/album/bar?from=x#t")).toEqual({ kind: "album", url: "https://foo.bandcamp.com/album/bar", host: "foo.bandcamp.com" });
    expect(normalizeBandcampUrl("http://foo.bandcamp.com/track/baz/")).toMatchObject({ kind: "track", url: "https://foo.bandcamp.com/track/baz" });
    expect(normalizeBandcampUrl("foo.bandcamp.com")).toMatchObject({ kind: "artist", url: "https://foo.bandcamp.com/music" });
    expect(normalizeBandcampUrl("https://Foo.Bandcamp.com/music")).toMatchObject({ kind: "artist" });
    expect(normalizeBandcampUrl("https://foo.bandcamp.com/releases")).toMatchObject({ kind: "artist" });
  });
  it("rejects non-bandcamp and unsupported paths", () => {
    expect(() => normalizeBandcampUrl("https://example.com/album/x")).toThrow(/artist subdomain/);
    expect(() => normalizeBandcampUrl("https://bandcamp.com/discover")).toThrow();
    expect(() => normalizeBandcampUrl("https://foo.bandcamp.com/merch")).toThrow(/Unsupported/);
    expect(() => normalizeBandcampUrl("not a url at all ::")).toThrow();
  });
});
