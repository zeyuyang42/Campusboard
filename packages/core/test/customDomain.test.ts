import { describe, it, expect } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { createCore } from "../src/core.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { parseMusicPage } from "../src/scrape/parseMusic.js";
import { albumUrlsInLibrary, artistUrlsInLibrary } from "../src/db/repos/albums.js";
import { fixture } from "./helpers.js";
import { isFetchableBandcampUrl } from "../src/scrape/url.js";
import { FetchQueue } from "../src/scrape/http.js";

// Zoe Keating serves Bandcamp from music.zoekeating.com. Fetching that host
// answers 303 -> zoekeating.bandcamp.com, whose pages report the custom domain
// in data-tralbum.url (og:url on album pages is the subdomain).
const CUSTOM = "https://music.zoekeating.com";
const SUB = "https://zoekeating.bandcamp.com";
const ALBUM = `${CUSTOM}/album/snowmelt-ep`;

describe("custom-domain pages", () => {
  it("album pages report the custom domain as the canonical URL", () => {
    const a = parseTralbumPage(fixture("custom-album"), 0);
    expect(a.url).toBe(ALBUM);
    expect(a.artist).toMatchObject({ name: "Zoe Keating", url: CUSTOM });
    expect(a.tracks.length).toBeGreaterThan(0);
    expect(a.tracks.some((t) => t.streamable && /bcbits\.com\//.test(t.stream_url ?? ""))).toBe(true);
  });

  it("music pages resolve release links against the custom domain, whichever host served them", () => {
    for (const fetchedFrom of [SUB, CUSTOM]) {
      const m = parseMusicPage(fixture("custom-music"), fetchedFrom);
      expect(m.origin).toBe(CUSTOM);
      expect(m.band?.name).toBe("Zoe Keating");
      expect(m.items.map((i) => i.url)).toContain(ALBUM);
      expect(m.items.every((i) => i.url.startsWith(`${CUSTOM}/`))).toBe(true);
    }
  });

  it("keeps the fetched origin for ordinary subdomain music pages", () => {
    expect(parseMusicPage(fixture("music"), "https://illuminatihotties.bandcamp.com").origin).toBe("https://illuminatihotties.bandcamp.com");
  });

  it("rejects pages that aren't Bandcamp with not_bandcamp", () => {
    const html = `<html><head><title>Some Shop</title></head><body><a href="/album/x">x</a></body></html>`;
    expect(() => parseTralbumPage(html)).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
    expect(() => parseMusicPage(html, "https://shop.example.com")).toThrow(expect.objectContaining({ code: "not_bandcamp" }));
  });

  it("rejects a data-tralbum whose url isn't a Bandcamp-shaped album or track", () => {
    const html = fixture("custom-album").replace(/(data-tralbum="[^"]*?)&quot;url&quot;:&quot;https:\/\/music\.zoekeating\.com\/album\/snowmelt-ep&quot;/, "$1&quot;url&quot;:&quot;http://127.0.0.1/admin&quot;");
    expect(html).not.toBe(fixture("custom-album"));
    expect(() => parseTralbumPage(html)).toThrow(expect.objectContaining({ code: "parse_failed" }));
  });
});

describe("custom domains through core", () => {
  function fakeBandcamp() {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      // Either host serves the same page (the custom domain redirects to the subdomain).
      const path = url.replace(CUSTOM, "").replace(SUB, "");
      if (path === "/album/snowmelt-ep") return new Response(fixture("custom-album"));
      if (path === "/music") return new Response(fixture("custom-music"));
      return new Response("", { status: 404 });
    };
    return { fetch, calls };
  }

  async function waitForJob(core: ReturnType<typeof createCore>, id: number) {
    for (let i = 0; i < 100; i++) {
      const j = await core.job(id);
      if (j && (j.status === "done" || j.status === "failed")) return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("job did not finish");
  }

  it("imports, dedupes, browses and refreshes by the canonical custom-domain URL", async () => {
    const db = new NodeDb();
    const { fetch, calls } = fakeBandcamp();
    const core = createCore({ db, fetch });

    // Pasted as the subdomain URL: stored under the custom domain.
    const j1 = await waitForJob(core, (await core.import({ url: `${SUB}/album/snowmelt-ep` })).id);
    expect(j1.status).toBe("done");
    let albums = await core.albums();
    expect(albums).toHaveLength(1);
    expect(albums[0].url).toBe(ALBUM);
    expect(await albumUrlsInLibrary(db)).toContain(ALBUM);
    expect(await artistUrlsInLibrary(db)).toContain(CUSTOM);

    // Pasted again as the custom-domain URL (served from the page cache or a refetch): no duplicate.
    const j2 = await waitForJob(core, (await core.import({ url: `${ALBUM}?from=search` })).id);
    expect(j2.status).toBe("done");
    albums = await core.albums();
    expect(albums).toHaveLength(1);

    // Browsing either host finds the album in the library and reports the canonical URL.
    const b = await core.browse(SUB);
    expect(b.url).toBe(`${CUSTOM}/music`);
    expect(b.items.find((i) => i.url === ALBUM)?.album_id).toBe(albums[0].id);

    // Refresh re-fetches the stored canonical URL, the one the http scope must allow.
    calls.length = 0;
    await core.refreshAlbum(albums[0].id);
    expect(calls).toEqual([ALBUM]);
  }, 15_000);

  it("fails an import from a host that isn't Bandcamp with not_bandcamp", async () => {
    const core = createCore({ db: new NodeDb(), fetch: async () => new Response("<html><title>Blog</title></html>") });
    const j = await waitForJob(core, (await core.import({ url: "https://blog.example.com/album/x" })).id);
    expect(j.status).toBe("failed");
    expect(j.items?.[0]?.error ?? j.error).toMatch(/not_bandcamp/);
  });
});

describe("release links from a page are untrusted", () => {
  const evil =
    `<html><div data-band="{&quot;id&quot;:1,&quot;name&quot;:&quot;X&quot;}"></div><ol id="music-grid">` +
    ["https://192.168.1.1/album/router", "http://localhost/track/x", "https://nas.internal/album/y", "https://music.example.com:8080/album/z", "https://good.example.com/album/ok", "/album/local-ok", "https://good.example.com/album/ok/extra"]
      .map((h) => `<li class="music-grid-item"><a href="${h}"><p class="title">t</p></a></li>`).join("") +
    `</ol></html>`;

  it("parseMusicPage keeps only normalized public album/track URLs", () => {
    expect(parseMusicPage(evil, "https://artist.example.org").items.map((i) => i.url)).toEqual([
      "https://good.example.com/album/ok",
      "https://artist.example.org/album/local-ok",
    ]);
  });

  it("a discography import never queues a LAN or malformed URL", async () => {
    const calls: string[] = [];
    const core = createCore({ db: new NodeDb(), fetch: async (url: string) => { calls.push(url); return url.endsWith("/music") ? new Response(evil) : new Response("<html></html>"); } });
    const job = await core.import({ url: "https://artist.example.org" });
    for (let i = 0; i < 100 && !["done", "failed"].includes((await core.job(job.id))!.status); i++) await new Promise((r) => setTimeout(r, 50));
    const j = (await core.job(job.id))!;
    expect(j.items!.map((i) => i.url).sort()).toEqual(["https://artist.example.org/album/local-ok", "https://good.example.com/album/ok"]);
    expect(calls.every((u) => isFetchableBandcampUrl(u))).toBe(true);
  }, 15_000);
});

describe("scope refusals", () => {
  it("turn a redirect out of scope into not_bandcamp without retrying", async () => {
    let calls = 0;
    const queue = new FetchQueue(async () => { calls++; throw "url not allowed on the configured scope: https://www.apple.com/apple-music/"; }, 0);
    await expect(queue.fetchText("https://www.apple.com/music")).rejects.toMatchObject({ code: "not_bandcamp" });
    expect(calls).toBe(1);
  });
});

describe("isFetchableBandcampUrl", () => {
  it("allows Bandcamp hosts and Bandcamp-shaped paths on public custom hosts only", () => {
    expect(isFetchableBandcampUrl("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic")).toBe(true);
    expect(isFetchableBandcampUrl("https://f4.bcbits.com/img/a1_2.jpg")).toBe(true);
    expect(isFetchableBandcampUrl("https://music.sufjan.com/album/javelin?x=1")).toBe(true);
    expect(isFetchableBandcampUrl("https://music.sufjan.com/music")).toBe(true);
    expect(isFetchableBandcampUrl("https://music.sufjan.com/")).toBe(false);
    expect(isFetchableBandcampUrl("https://music.sufjan.com/admin")).toBe(false);
    expect(isFetchableBandcampUrl("http://music.sufjan.com/album/javelin")).toBe(false);
    for (const u of ["https://127.0.0.1/album/x", "https://localhost/album/x", "https://box.lan/album/x", "https://r.home.arpa/music", "https://a.corp/album/x", "https://x.bandcamp.com:444/album/y"]) {
      expect(isFetchableBandcampUrl(u), u).toBe(false);
    }
  });
});
