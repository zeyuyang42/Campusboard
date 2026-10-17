import { describe, it, expect } from "vitest";
import { normalizeBandcampUrl, isBandcampHost } from "../src/scrape/url.js";

describe("normalizeBandcampUrl", () => {
  it("classifies album, track and artist URLs", () => {
    expect(normalizeBandcampUrl("https://foo.bandcamp.com/album/bar?from=x#t")).toEqual({ kind: "album", url: "https://foo.bandcamp.com/album/bar", host: "foo.bandcamp.com", custom: false });
    expect(normalizeBandcampUrl("http://foo.bandcamp.com/track/baz/")).toMatchObject({ kind: "track", url: "https://foo.bandcamp.com/track/baz" });
    expect(normalizeBandcampUrl("foo.bandcamp.com")).toMatchObject({ kind: "artist", url: "https://foo.bandcamp.com/music" });
    expect(normalizeBandcampUrl("https://Foo.Bandcamp.com/music")).toMatchObject({ kind: "artist" });
    expect(normalizeBandcampUrl("https://foo.bandcamp.com/releases")).toMatchObject({ kind: "artist" });
  });
  it("accepts Bandcamp-shaped paths on custom artist domains", () => {
    expect(normalizeBandcampUrl("https://music.sufjan.com/album/javelin?from=search")).toEqual({ kind: "album", url: "https://music.sufjan.com/album/javelin", host: "music.sufjan.com", custom: true });
    expect(normalizeBandcampUrl("http://Music.ZoeKeating.com/track/tango/")).toMatchObject({ kind: "track", url: "https://music.zoekeating.com/track/tango", custom: true });
    expect(normalizeBandcampUrl("music.zoekeating.com")).toMatchObject({ kind: "artist", url: "https://music.zoekeating.com/music", custom: true });
    expect(normalizeBandcampUrl("https://music.zoekeating.com/music/")).toMatchObject({ kind: "artist", url: "https://music.zoekeating.com/music" });
    expect(normalizeBandcampUrl("https://music.zoekeating.com./releases")).toMatchObject({ kind: "artist", host: "music.zoekeating.com" });
  });
  it("rejects non-bandcamp and unsupported paths", () => {
    expect(() => normalizeBandcampUrl("https://example.com/blog/post")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => normalizeBandcampUrl("https://example.com/album/x/extra")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => normalizeBandcampUrl("https://bandcamp.com/discover")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => normalizeBandcampUrl("https://www.bandcamp.com/album/x")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => normalizeBandcampUrl("https://foo.bandcamp.com/merch")).toThrow(/Unsupported/);
    expect(() => normalizeBandcampUrl("not a url at all ::")).toThrow();
    expect(() => normalizeBandcampUrl("ftp://music.example.com/album/x")).toThrow();
  });
  it("refuses custom hosts that point at the local machine or network", () => {
    for (const u of ["http://localhost/album/x", "https://127.0.0.1/album/x", "https://192.168.1.10/music", "https://[::1]/album/x", "https://nas.local/album/x", "https://intranet/album/x", "https://music.example.com:8443/album/x", "https://user:pw@music.example.com/album/x", "https://app.localhost/album/x"]) {
      expect(() => normalizeBandcampUrl(u), u).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    }
  });
});

describe("isBandcampHost", () => {
  it("matches bandcamp.com and its subdomains only", () => {
    expect(isBandcampHost("foo.bandcamp.com")).toBe(true);
    expect(isBandcampHost("bandcamp.com")).toBe(true);
    expect(isBandcampHost("notbandcamp.com")).toBe(false);
    expect(isBandcampHost("bandcamp.com.evil.example")).toBe(false);
    expect(isBandcampHost("music.sufjan.com")).toBe(false);
  });
});
