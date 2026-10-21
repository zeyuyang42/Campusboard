import { describe, it, expect, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { createCore } from "../src/core.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { previewQueueId, previewReleaseTracks } from "../src/services/discover.js";
import { upsertTralbum } from "../src/services/importService.js";
import { RADIO_CDN_URL } from "../src/scrape/radio.js";
import { TralbumSchema } from "../src/scrape/schemas.js";

/** The album fixture with every `featured_track_id` replaced by `json` (raw JSON text). */
const withFeatured = (json: string) => fixture("album").replace(/(&quot;featured_track_id&quot;:)\d+/g, `$1${json.replace(/"/g, "&quot;")}`);

const ALBUM_URL = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";

function setup(pages: Record<string, string>) {
  const db = new NodeDb();
  const fetch = vi.fn(async (url: string) => (url in pages ? new Response(pages[url]) : new Response("", { status: 404 })));
  return { db, fetch, core: createCore({ db, fetch }) };
}

describe("core.previewRelease", () => {
  it("makes a preview entry for every track, in album order, starting at the featured one", async () => {
    const { core, fetch } = setup({ [ALBUM_URL]: fixture("album") });
    const r = await core.previewRelease(`${ALBUM_URL}?from=search`);
    const parsed = parseTralbumPage(fixture("album"));
    expect(r.album_id).toBeNull();
    expect(r.title).toBe(parsed.title);
    expect(r.tracks.map((t) => t.preview!.track_id)).toEqual(parsed.tracks.map((t) => t.track_id));
    expect(r.tracks[r.start].preview!.track_id).toBe(parsed.featured_track_id);
    for (const t of r.tracks) {
      expect(t.id).toBe(previewQueueId(t.preview!.track_id));
      expect(t.album_id).toBe(t.id);
      expect(t.preview!.item_url).toBe(ALBUM_URL);
      expect(t.preview!.stream_url).toMatch(RADIO_CDN_URL);
      expect(t.album_title).toBe(parsed.title);
      expect(t.artist_name).toBe(parsed.artist.name);
      expect(t.art_id).toBe(parsed.art_id);
    }
    // A second Play reads the page cache.
    await core.previewRelease(ALBUM_URL);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves out a pre-order's unreleased tracks", async () => {
    const url = "https://pisstheband.bandcamp.com/album/you-made-me-skin-on-linen";
    const { core } = setup({ [url]: fixture("preorder") });
    const r = await core.previewRelease(url);
    expect(r.tracks.map((t) => t.preview!.track_id)).toEqual([1460785713, 2485847214, 2882906465]);
    expect(r.start).toBe(2);
  });

  it("starts at 0 when the page names no featured track or it has no stream", () => {
    const parsed = parseTralbumPage(fixture("album"));
    expect(previewReleaseTracks({ ...parsed, featured_track_id: null }, ALBUM_URL).start).toBe(0);
    expect(previewReleaseTracks({ ...parsed, featured_track_id: 1 }, ALBUM_URL).start).toBe(0);
    // A stream outside Bandcamp's CDN is dropped.
    const bad = { ...parsed, tracks: parsed.tracks.map((t, i) => (i === 0 ? { ...t, stream_url: "https://evil.example/stream/x" } : t)) };
    expect(previewReleaseTracks(bad, ALBUM_URL).tracks).toHaveLength(parsed.tracks.length - 1);
  });

  it("plays the library album instead, without a request", async () => {
    const { db, core, fetch } = setup({});
    const id = await upsertTralbum(db, parseTralbumPage(fixture("album")));
    const r = await core.previewRelease(ALBUM_URL);
    expect(r.album_id).toBe(id);
    expect(r.tracks.length).toBeGreaterThan(0);
    expect(r.tracks.every((t) => t.album_id === id && !t.preview && t.album_title)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finds the library album under the custom domain the page names", async () => {
    const { db, core, fetch } = setup({ "https://zoekeating.bandcamp.com/album/snowmelt-ep": fixture("custom-album") });
    const id = await upsertTralbum(db, parseTralbumPage(fixture("custom-album")));
    expect((await core.previewRelease("https://zoekeating.bandcamp.com/album/snowmelt-ep")).album_id).toBe(id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses artist pages and pages that aren't Bandcamp", async () => {
    const { core, fetch } = setup({ "https://example.com/album/x": "<html><title>Hi</title></html>" });
    await expect(core.previewRelease("https://illuminatihotties.bandcamp.com/music")).rejects.toMatchObject({ code: "invalid_url" });
    await expect(core.previewRelease("https://192.168.1.1/album/x")).rejects.toMatchObject({ code: "not_bandcamp" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(core.previewRelease("https://example.com/album/x")).rejects.toMatchObject({ code: "not_bandcamp" });
  });

  it("never fails a page over a strange featured_track_id", () => {
    for (const v of ['"282506895"', '""', '{}', 'true']) {
      const html = withFeatured(v);
      expect(html).not.toBe(fixture("album"));
      const p = parseTralbumPage(html);
      expect(p.featured_track_id).toBeNull();
      expect(p.tracks.length).toBeGreaterThan(0);
    }
    expect(TralbumSchema.shape.featured_track_id.parse(undefined)).toBeUndefined();
  });

  it("keeps the page address only when it is fetchable, else the one it was read from", () => {
    const parsed = parseTralbumPage(fixture("album"));
    const { tracks } = previewReleaseTracks({ ...parsed, url: "http://192.168.1.1/album/x" }, ALBUM_URL);
    expect(tracks.every((t) => t.preview!.item_url === ALBUM_URL && t.album_url === ALBUM_URL)).toBe(true);
  });

  it("reads the page for an album waiting for its delete", async () => {
    const { db, core, fetch } = setup({ [ALBUM_URL]: fixture("album") });
    const id = await upsertTralbum(db, parseTralbumPage(fixture("album")));
    await core.removeAlbumLater(id);
    const r = await core.previewRelease(ALBUM_URL);
    expect(r.album_id).toBeNull();
    expect(r.tracks[0].preview).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads the page for a library pre-order with nothing out, and says so when the page has nothing either", async () => {
    const url = "https://pisstheband.bandcamp.com/album/you-made-me-skin-on-linen";
    const preorder = parseTralbumPage(fixture("preorder"));
    const nothing = { ...preorder, tracks: preorder.tracks.map((t) => ({ ...t, streamable: false, stream_url: null, stream_expires_at: null })) };
    // Out by now: the page streams three tracks.
    const a = setup({ [url]: fixture("preorder") });
    await upsertTralbum(a.db, nothing);
    const r = await a.core.previewRelease(url);
    expect(r.album_id).toBeNull();
    expect(r.tracks).toHaveLength(3);
    expect(a.fetch).toHaveBeenCalledTimes(1);
    // Still nothing out: an error, never a silent no-op.
    const html = fixture("preorder").replaceAll("&quot;mp3-128&quot;:", "&quot;x&quot;:");
    const b = setup({ [url]: html });
    await upsertTralbum(b.db, nothing);
    await expect(b.core.previewRelease(url)).rejects.toMatchObject({ code: "not_streamable" });
  });
});
