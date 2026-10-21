import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import {
  DEFAULT_DISCOVER, DISCOVER_ENDPOINT, LOCATION_SEARCH_ENDPOINT, STREAM_REFRESH_ENDPOINT, TAG_SEARCH_ENDPOINT,
  discoverBatch, discoverBody, discoverQuery, discoverWebUrl, locationSuggestions, parseDiscoverResponse, parseDiscoverUrl, tagSuggestions,
} from "../src/scrape/discover.js";
import { PreviewService, previewQueueTrack, previewQueueId, isPreviewTrack, isQueuePreview } from "../src/services/discover.js";
import { isRadioTrack } from "../src/services/radio.js";
import { resumeEligible } from "../src/services/resume.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { createCore } from "../src/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (name: string) => readFileSync(path.join(here, "fixtures", `${name}.json`), "utf8");
const raw = () => JSON.parse(json("discover"));

describe("parseDiscoverResponse (discover_web)", () => {
  const page = parseDiscoverResponse(raw());

  it("reads every result with a clean URL, art id and featured track", () => {
    expect(page.items).toHaveLength(12);
    expect(page.total).toBe(1461);
    expect(page.cursor).toBe("AoMIP0vi9njVqcvf2AIqYTU0OTkwNjQzOQ==");
    expect(page.items[0]).toEqual({
      url: "https://resonantlanguage.bandcamp.com/album/discorporate",
      title: "Discorporate",
      artist: "Resonant Language",
      artist_url: "https://resonantlanguage.bandcamp.com/music",
      art_id: 3014362078,
      item_type: "album",
      release_date: "2026-09-04",
      track_count: 6,
      preorder: false,
      featured: {
        track_id: 25866226, title: "Discorporate", artist: "Resonant Language", duration: 162.923,
        stream_url: expect.stringMatching(/^https:\/\/t4\.bcbits\.com\/stream\/[0-9a-f]+\/mp3-128\/25866226\?p=0&ts=\d+&t=[0-9a-f]+&token=/),
      },
      album_id: null,
    });
    for (const i of page.items) expect(i.url).not.toContain("?");
    // A custom-domain artist keeps its own host (the library stores the data-tralbum URL, which is the same).
    expect(page.items.map((i) => i.url)).toContain("https://deathbysheep.com/album/5g-death-grid");
  });

  it("drops a stream URL outside Bandcamp's CDN, and results that aren't releases", () => {
    const r = raw();
    r.results[0].featured_track.stream_url = "https://evil.example/stream/x/mp3-128/1?ts=1";
    r.results[1].item_url = "https://resonantlanguage.bandcamp.com/merch?from=discover_page";
    r.results[2].primary_image = null;
    r.results[3].is_album_preorder = true;
    const p = parseDiscoverResponse(r);
    expect(p.items).toHaveLength(11);
    expect(p.items[0].featured).toBeNull();
    expect(p.items[1].art_id).toBeNull();
    expect(p.items[2].preorder).toBe(true);
  });

  it("reports an error answer and has no cursor once the results run out", () => {
    expect(() => parseDiscoverResponse({ error: true, error_message: "bad type" })).toThrow(/bad type/);
    expect(parseDiscoverResponse({ results: [], result_count: 0, cursor: "x" }).cursor).toBeNull();
  });

  it("posts the body Bandcamp's own page sends", async () => {
    const fetch = vi.fn(async () => new Response(json("discover")));
    const p = await discoverBatch(new FetchQueue(fetch, 0), { tags: ["electronic", "breaks"], slice: "new", time: 2, location: 2950159, category: 2 }, "abc");
    expect(p.items).toHaveLength(12);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DISCOVER_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      category_id: 2, tag_norm_names: ["electronic", "breaks"], geoname_id: 2950159, slice: "new", time_facet_id: 2,
      cursor: "abc", size: 60, include_result_types: ["a", "s"], followed_bands: false,
    });
    expect(discoverBody({ tags: [], slice: "top", time: null, location: null, category: 0 }, null)).toMatchObject({ cursor: "*", geoname_id: 0, time_facet_id: null });
  });
});

describe("tag and location suggestions", () => {
  it("reads Bandcamp's tag autocomplete", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(json("tag-search")));
    const tags = await tagSuggestions(new FetchQueue(fetch, 0), "glit");
    expect(fetch.mock.calls[0][0]).toBe(TAG_SEARCH_ENDPOINT);
    expect(tags[0]).toEqual({ norm_name: "glitch", display_name: "glitch", count: 78870 });
    expect(tags.find((t) => t.norm_name === "glitch-hop")?.display_name).toBe("glitch hop");
  });
  it("reads the place search with numeric ids", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(json("geoname-search")));
    const locs = await locationSuggestions(new FetchQueue(fetch, 0), "berl");
    expect(fetch.mock.calls[0][0]).toBe(LOCATION_SEARCH_ENDPOINT);
    expect(locs[1]).toEqual({ id: 2950159, label: "Berlin, Berlin" });
    expect(locs).toHaveLength(5);
  });
});

describe("discover links", () => {
  it("reads the tags from the path", () => {
    expect(parseDiscoverUrl("https://bandcamp.com/discover/electronic+breaks+glitch")).toEqual({ tags: ["electronic", "breaks", "glitch"], slice: "top", time: null, location: null, category: 0 });
  });
  it("reads s, t (slug or id), loc, tags= and the category segment", () => {
    expect(parseDiscoverUrl("https://bandcamp.com/discover/electronic/vinyl?s=new&t=this-week&loc=2950159&tags=glitch-hop,breaks"))
      .toEqual({ tags: ["electronic", "glitch-hop", "breaks"], slice: "new", time: 1, location: 2950159, category: 2 });
    expect(parseDiscoverUrl("https://bandcamp.com/discover?t=3&s=rand")).toMatchObject({ tags: [], slice: "rand", time: 3, category: 0 });
    expect(parseDiscoverUrl("https://bandcamp.com/discover/all/cassette?s=bogus&t=fresh&loc=x")).toEqual({ tags: [], slice: "top", time: null, location: null, category: 4 });
  });
  it("honours digital, vinyl, cd and cassette, and nothing else, as the category", () => {
    const cat = (u: string) => parseDiscoverUrl(u)?.category;
    expect(cat("https://bandcamp.com/discover/electronic+breaks+glitch/vinyl")).toBe(2);
    expect(cat("https://bandcamp.com/discover/jazz/digital")).toBe(1);
    expect(cat("https://bandcamp.com/discover/jazz/CD")).toBe(3);
    expect(cat("https://bandcamp.com/discover/jazz/tshirt")).toBe(0);
    expect(cat("https://bandcamp.com/discover/jazz/all")).toBe(0);
    expect(cat("https://bandcamp.com/discover/jazz/5")).toBe(0);
    expect(cat("https://bandcamp.com/discover/jazz/2")).toBe(0);
    expect(cat("https://bandcamp.com/discover/jazz?cat=2")).toBe(0);
    expect(cat("https://bandcamp.com/discover/jazz?cat=vinyl")).toBe(2);
    expect(cat("https://bandcamp.com/discover/jazz/cassette?cat=vinyl")).toBe(4);
    expect(cat("https://bandcamp.com/discover/jazz?cat=9")).toBe(0);
    expect(discoverBody({ ...DEFAULT_DISCOVER, category: 3 }, null).category_id).toBe(3);
  });
  it("takes only https links and drops overlong tags", () => {
    expect(parseDiscoverUrl("http://bandcamp.com/discover/electronic")).toBeNull();
    expect(parseDiscoverUrl("https://bandcamp.com:8443/discover/electronic")).toBeNull();
    expect(parseDiscoverUrl(`https://bandcamp.com/discover/electronic+${"x".repeat(65)}?tags=${"y".repeat(64)}`)?.tags).toEqual(["electronic", "y".repeat(64)]);
  });
  it("is null for anything else", () => {
    expect(parseDiscoverUrl("https://bandcamp.com/radio")).toBeNull();
    expect(parseDiscoverUrl("https://artist.bandcamp.com/discover/x")).toBeNull();
    expect(parseDiscoverUrl("not a url at all")).toBeNull();
  });
  it("round-trips through the app's query and Bandcamp's link", () => {
    const p = { tags: ["electronic", "glitch"], slice: "new" as const, time: 1, location: 2950159, category: 0 };
    expect(parseDiscoverUrl(`https://bandcamp.com/discover?${discoverQuery(p)}`)).toEqual(p);
    expect(discoverWebUrl(p)).toBe("https://bandcamp.com/discover/electronic+glitch?s=new&t=this-week&loc=2950159");
    expect(parseDiscoverUrl(discoverWebUrl(p))).toEqual(p);
    expect(discoverQuery({ tags: [], slice: "top", time: null, location: null, category: 0 })).toBe("s=top");
    const v = { ...p, category: 2 };
    expect(discoverQuery(v)).toContain("cat=vinyl");
    expect(parseDiscoverUrl(`https://bandcamp.com/discover?${discoverQuery(v)}`)).toEqual(v);
    expect(discoverWebUrl(v)).toBe("https://bandcamp.com/discover/electronic+glitch/vinyl?s=new&t=this-week&loc=2950159");
    expect(parseDiscoverUrl(discoverWebUrl(v))).toEqual(v);
    expect(discoverWebUrl({ ...DEFAULT_DISCOVER, category: 4 })).toBe("https://bandcamp.com/discover/all/cassette");
  });
});

describe("preview queue entries", () => {
  const item = parseDiscoverResponse(raw()).items[0];
  const t = previewQueueTrack(item)!;

  it("are negative, never radio, and carry the release", () => {
    expect(t.id).toBe(previewQueueId(25866226));
    expect(t.id).toBeLessThan(-1e10);
    expect(t.album_id).toBe(t.id);
    expect(t).toMatchObject({ title: "Discorporate", album_title: "Discorporate", artist_name: "Resonant Language", art_id: 3014362078, track_artist: null, streamable: true });
    expect(isPreviewTrack(t)).toBe(true);
    expect(isRadioTrack(t)).toBe(false);
    expect(isRadioTrack({ id: -5 })).toBe(true); // an old saved episode without its field
    // A short preview doesn't resume like an episode would.
    expect(resumeEligible(t)).toBe(false);
    // Not even a long one: previews never take resume rows.
    expect(resumeEligible({ ...t, duration: 3600 }, 3600)).toBe(false);
    expect(isQueuePreview(t.preview)).toBe(true);
    expect(isQueuePreview({ ...t.preview, stream_url: "https://evil.example/stream/x" })).toBe(false);
    expect(isQueuePreview({ ...t.preview, track_id: -1 })).toBe(false);
    expect(previewQueueTrack({ ...item, featured: null })).toBeNull();
  });
});

const cdn = (id: number, hours: number) => `https://t4.bcbits.com/stream/abc/mp3-128/${id}?p=0&ts=${Math.floor(Date.now() / 1000 + hours * 3600)}&t=sig&token=x`;

describe("PreviewService.streamUrl", () => {
  const album = fixture("album");
  const ALBUM_URL = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
  const TRACK = 282506895;
  function setup(refresh: () => Response) {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(`${STREAM_REFRESH_ENDPOINT}?url=`)) return refresh();
      if (url === ALBUM_URL) return new Response(album);
      return new Response("", { status: 404 });
    });
    return { fetch, svc: new PreviewService(new NodeDb(), new FetchQueue(fetch, 0)) };
  }

  it("uses the stored URL while it is fresh (no request)", async () => {
    const { fetch, svc } = setup(() => new Response("{}"));
    const url = cdn(TRACK, 20);
    expect((await svc.streamUrl({ item_url: ALBUM_URL, track_id: TRACK, stream_url: url })).url).toBe(url);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes a URL near expiry, and on force, then remembers it", async () => {
    const fresh = cdn(TRACK, 24);
    const { fetch, svc } = setup(() => new Response(JSON.stringify({ track_id: TRACK, url: fresh })));
    const p = { item_url: ALBUM_URL, track_id: TRACK, stream_url: cdn(TRACK, 0.5) };
    expect((await svc.streamUrl(p)).url).toBe(fresh);
    expect((await svc.streamUrl(p)).url).toBe(fresh);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(`${STREAM_REFRESH_ENDPOINT}?url=${encodeURIComponent(p.stream_url)}`);
    await svc.streamUrl({ ...p, stream_url: cdn(TRACK, 20) }, true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to the release page when the refresh fails or leaves the CDN", async () => {
    const want = parseTralbumPage(album).tracks.find((t) => t.track_id === TRACK)!.stream_url;
    for (const answer of [() => new Response("", { status: 410 }), () => new Response(JSON.stringify({ track_id: TRACK, url: "https://evil.example/stream/x" }))]) {
      const { fetch, svc } = setup(answer);
      expect((await svc.streamUrl({ item_url: ALBUM_URL, track_id: TRACK, stream_url: cdn(TRACK, -1) })).url).toBe(want);
      expect(fetch.mock.calls.map((c) => String(c[0]).split("?")[0])).toEqual([STREAM_REFRESH_ENDPOINT, ALBUM_URL]);
    }
  });

  it("rejects a refresh answer for another track and reads the page instead", async () => {
    const want = parseTralbumPage(album).tracks.find((t) => t.track_id === TRACK)!.stream_url;
    const { fetch, svc } = setup(() => new Response(JSON.stringify({ track_id: TRACK + 1, url: cdn(TRACK + 1, 24) })));
    expect((await svc.streamUrl({ item_url: ALBUM_URL, track_id: TRACK, stream_url: cdn(TRACK, -1) })).url).toBe(want);
    expect(fetch.mock.calls.map((c) => String(c[0]).split("?")[0])).toEqual([STREAM_REFRESH_ENDPOINT, ALBUM_URL]);
  });

  it("refuses a track the page doesn't have", async () => {
    const { svc } = setup(() => new Response("", { status: 403 }));
    await expect(svc.streamUrl({ item_url: ALBUM_URL, track_id: 1, stream_url: cdn(1, -1) })).rejects.toMatchObject({ code: "not_streamable" });
  });
});

describe("core.discover", () => {
  it("marks results that are in the library", async () => {
    const db = new NodeDb();
    const parsed = parseTralbumPage(fixture("album"));
    const albumId = await upsertTralbum(db, { ...parsed, url: "https://resonantlanguage.bandcamp.com/album/eviscerate" });
    const core = createCore({ db, fetch: async () => new Response(json("discover")) });
    const page = await core.discover({ tags: ["electronic"], slice: "top", time: null, location: null, category: 0 });
    expect(page.items[1].album_id).toBe(albumId);
    expect(page.items.filter((i) => i.album_id)).toHaveLength(1);
    // An album waiting for its delete (#93) is not in the library.
    await core.removeAlbumLater(albumId);
    expect((await core.discover({ tags: [], slice: "top", time: null, location: null, category: 0 })).items[1].album_id).toBeNull();
    expect(await core.discoverTags("g")).toEqual([]);
    expect(await core.discoverLocations("be")).toEqual([]);
  });
});
