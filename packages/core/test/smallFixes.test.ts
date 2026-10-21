import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { createCore } from "../src/core.js";
import { cachedFetchText, prunePageCache } from "../src/services/pageCache.js";
import { FetchQueue } from "../src/scrape/http.js";
import * as pl from "../src/db/repos/playlists.js";
import { ART_FETCH_TIMEOUT_MS, PAGE_CACHE_MAX_ROWS, PLAYLIST_NAME_MAX } from "../src/config.js";

/** A fetch that never settles on its own, but rejects with AbortError when its signal fires. */
function hangingFetch() {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  return { fetch, calls };
}

async function cacheRows(db: NodeDb): Promise<{ url: string; fetched_at: number }[]> {
  return db.select("SELECT url, fetched_at FROM page_cache ORDER BY fetched_at DESC, url");
}

describe("prunePageCache", () => {
  let db: NodeDb;
  beforeEach(() => { db = new NodeDb(); });

  it("drops rows past the age limit", async () => {
    const t = Date.now();
    await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES ('old', '', ?), ('new', '', ?)", [t - 2 * 86_400_000, t - 1000]);
    await prunePageCache(db);
    expect((await cacheRows(db)).map((r) => r.url)).toEqual(["new"]);
  });

  it("caps the row count and keeps the newest by fetched_at", async () => {
    const t = Date.now();
    for (let i = 0; i < 10; i++) await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES (?, '', ?)", [`u${i}`, t - i * 1000]);
    await prunePageCache(db, 86_400_000, 3);
    expect((await cacheRows(db)).map((r) => r.url)).toEqual(["u0", "u1", "u2"]);
  });

  it("defaults to PAGE_CACHE_MAX_ROWS", async () => {
    const t = Date.now();
    for (let i = 0; i < PAGE_CACHE_MAX_ROWS + 5; i++) await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES (?, '', ?)", [`u${i}`, t - i]);
    await prunePageCache(db);
    const rows = await cacheRows(db);
    expect(rows).toHaveLength(PAGE_CACHE_MAX_ROWS);
    expect(rows[0].url).toBe("u0");
  });

  it("runs at startup via createCore and again from cachedFetchText", async () => {
    const t = Date.now();
    await db.run("INSERT INTO page_cache (url, html, fetched_at) VALUES ('stale', '', ?)", [t - 2 * 86_400_000]);
    createCore({ db, fetch: hangingFetch().fetch });
    await vi.waitFor(async () => expect(await cacheRows(db)).toHaveLength(0));

    // A fresh db (never pruned) gets pruned on its first cache write.
    const db2 = new NodeDb();
    await db2.run("INSERT INTO page_cache (url, html, fetched_at) VALUES ('stale', '', ?)", [t - 2 * 86_400_000]);
    const queue = new FetchQueue(async () => new Response("<html></html>", { status: 200 }), 0);
    await cachedFetchText(db2, queue, "https://x.bandcamp.com/music");
    expect((await cacheRows(db2)).map((r) => r.url)).toEqual(["https://x.bandcamp.com/music"]);
  });

  it("returns the fetched page even when the opportunistic prune fails", async () => {
    const inner = new NodeDb();
    const failingPrune: typeof inner = Object.assign(Object.create(inner), {
      run: (sql: string, params?: unknown[]) =>
        sql.startsWith("DELETE FROM page_cache") ? Promise.reject(new Error("database is locked")) : inner.run(sql, params),
    });
    const queue = new FetchQueue(async () => new Response("<html>ok</html>", { status: 200 }), 0);
    await expect(cachedFetchText(failingPrune, queue, "https://y.bandcamp.com/music")).resolves.toBe("<html>ok</html>");
  });
});

describe("getArtPalette", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns null when the art fetch hangs, aborting after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, calls } = hangingFetch();
    const core = createCore({ db: new NodeDb(), fetch });
    const pending = core.getArtPalette(872064409);
    await vi.advanceTimersByTimeAsync(ART_FETCH_TIMEOUT_MS - 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(calls[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null on a network error or a non-OK response, and clears its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failing = createCore({ db: new NodeDb(), fetch: async () => { throw new TypeError("network down"); } });
    await expect(failing.getArtPalette(1)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const notFound = createCore({ db: new NodeDb(), fetch: async () => new Response("", { status: 404 }) });
    await expect(notFound.getArtPalette(1)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("getArtSwatches (palette v2, #110)", () => {
  const row = { version: 1, swatches: [{ hex: "#c8321e", weight: 0.6 }, { hex: "#1f3f8a", weight: 0.4 }] };
  const keys = async (db: NodeDb) => (await db.select<{ art_key: number }>("SELECT art_key FROM art_swatches ORDER BY art_key")).map((r) => r.art_key);

  /** Stand-ins for the webview's image decoding: a 2x1 bitmap of two solid colours. */
  function stubDecode() {
    const px = new Uint8ClampedArray([200, 50, 30, 255, 200, 50, 30, 255, 30, 60, 200, 255, 30, 60, 200, 255]);
    vi.stubGlobal("createImageBitmap", async () => ({ close() { /* no-op */ } }));
    vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage() { /* no-op */ }, getImageData: () => ({ data: px }) }; } });
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it("answers from the cache without fetching, for album art and for a radio image (negative key)", async () => {
    const db = new NodeDb();
    await db.run("INSERT INTO art_swatches (art_key, swatches, version, computed_at) VALUES (?, ?, 1, 0), (?, ?, 1, 0)", [872064409, JSON.stringify(row), -3001, JSON.stringify(row)]);
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const core = createCore({ db, fetch });
    expect(await core.getArtSwatches({ artId: 872064409 })).toEqual(row);
    expect(await core.getArtSwatches({ imageId: 3001 })).toEqual(row);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a cached row that fails validation and refetches", async () => {
    const db = new NodeDb();
    await db.run("INSERT INTO art_swatches (art_key, swatches, version, computed_at) VALUES (?, ?, 1, 0), (?, ?, 1, 0)", [5, '{"version":1,"swatches":[{"hex":"red","weight":1}]}', 6, "not json"]);
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const core = createCore({ db, fetch });
    expect(await core.getArtSwatches({ artId: 5 })).toBeNull();
    expect(await core.getArtSwatches({ artId: 6 })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("on a miss fetches the 350px image once and fills both caches; a radio image is keyed negative and skips art_palettes", async () => {
    stubDecode();
    const db = new NodeDb();
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => { urls.push(url); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); });
    const core = createCore({ db, fetch });
    const s = await core.getArtSwatches({ artId: 872064409 });
    expect(urls).toEqual(["https://f4.bcbits.com/img/a0872064409_2.jpg"]);
    expect(s?.version).toBe(1);
    expect(s?.swatches.map((x) => x.hex)).toEqual(["#c8321e", "#1e3cc8"]);
    expect(await keys(db)).toEqual([872064409]);
    // The conservative palette came from the same decode: no second request for it.
    expect(await core.getArtPalette(872064409)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    const r = await core.getArtSwatches({ imageId: 1234567 });
    expect(urls[1]).toBe("https://f4.bcbits.com/img/0001234567_2.jpg");
    expect(r?.swatches).toHaveLength(2);
    expect(await keys(db)).toEqual([-1234567, 872064409]);
    expect(await db.select("SELECT art_id FROM art_palettes")).toEqual([{ art_id: 872064409 }]);
    expect(await core.getArtSwatches({ imageId: 1234567 })).toEqual(r);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("getArtPalette's miss also writes the swatches cache", async () => {
    stubDecode();
    const db = new NodeDb();
    const core = createCore({ db, fetch: async () => new Response(new Uint8Array([1]), { status: 200 }) });
    await core.getArtPalette(42);
    expect(await keys(db)).toEqual([42]);
  });

  it("returns null for a key that isn't one, without touching the network", async () => {
    const fetch = vi.fn();
    const core = createCore({ db: new NodeDb(), fetch });
    expect(await core.getArtSwatches({ artId: 0 })).toBeNull();
    expect(await core.getArtSwatches({ imageId: 1.5 })).toBeNull();
    expect(await core.getArtSwatches({ artId: Number.NaN })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("playlist names", () => {
  let db: NodeDb;
  beforeEach(() => { db = new NodeDb(); });

  it("normalises whitespace and control characters", () => {
    expect(pl.normalizePlaylistName("  mix  ")).toBe("mix");
    expect(pl.normalizePlaylistName("late\nnight\r\n\tdrive")).toBe("late night drive");
    expect(pl.normalizePlaylistName("a\u0000b\u007fc")).toBe("a b c");
    expect(pl.normalizePlaylistName("   \n\t ")).toBeNull();
    expect(pl.normalizePlaylistName("")).toBeNull();
  });

  it("caps length at PLAYLIST_NAME_MAX characters without splitting surrogate pairs", () => {
    expect(pl.normalizePlaylistName("x".repeat(500))).toHaveLength(PLAYLIST_NAME_MAX);
    const emoji = pl.normalizePlaylistName("🎵".repeat(150))!;
    expect(Array.from(emoji)).toHaveLength(PLAYLIST_NAME_MAX);
  });

  it("caps by grapheme cluster, so ZWJ emoji and combining accents stay whole", () => {
    const zwj = String.fromCodePoint(0x200d);
    const family = ["👩", "👩", "👧"].join(zwj); // one grapheme, five code points
    const out = pl.normalizePlaylistName(family.repeat(120))!;
    expect(out).toBe(family.repeat(PLAYLIST_NAME_MAX));
    const accented = "e" + String.fromCodePoint(0x301);
    expect(pl.normalizePlaylistName(accented.repeat(150))).toBe(accented.repeat(PLAYLIST_NAME_MAX));
  });

  it("strips zero-width and format characters, rejecting names made only of them", () => {
    const invisible = [0x200b, 0x2060, 0xfeff, 0x200e, 0x202e].map((c) => String.fromCodePoint(c)).join("");
    expect(pl.normalizePlaylistName(invisible)).toBeNull();
    expect(pl.normalizePlaylistName(` ${invisible} \n `)).toBeNull();
    expect(pl.normalizePlaylistName(`mi${invisible}x`)).toBe("mix");
    const joiners = [0x200d, 0x200c, 0x200d].map((c) => String.fromCodePoint(c)).join("");
    expect(pl.normalizePlaylistName(` ${joiners} `)).toBeNull();
  });

  it("keeps the tag characters of subdivision flags (England, Scotland, Wales)", () => {
    const flag = (code: string) =>
      String.fromCodePoint(0x1f3f4, ...[...code].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f);
    const flags = ["gbeng", "gbsct", "gbwls"].map(flag).join("");
    expect(pl.normalizePlaylistName(`Anthems ${flags}`)).toBe(`Anthems ${flags}`);
    // Seven code points, one grapheme: the cap counts each flag once.
    expect(pl.normalizePlaylistName(flag("gbsct").repeat(150))).toBe(flag("gbsct").repeat(PLAYLIST_NAME_MAX));
    const tagsOnly = String.fromCodePoint(0xe0067, 0xe0062, 0xe007f);
    expect(pl.normalizePlaylistName(` ${tagsOnly} `)).toBeNull();
  });

  it("createPlaylist stores the normalised name and rejects empty ones", async () => {
    const p = await pl.createPlaylist(db, "  road\ntrip  ");
    expect(p.name).toBe("road trip");
    await expect(pl.createPlaylist(db, " \n ")).rejects.toBeInstanceOf(pl.PlaylistNameError);
    await expect(pl.createPlaylist(db, "")).rejects.toMatchObject({ code: "invalid_playlist_name" });
    expect(await pl.listPlaylists(db)).toHaveLength(1);
  });

  it("renamePlaylist normalises, caps and rejects empty names without touching the row", async () => {
    const p = await pl.createPlaylist(db, "mix");
    expect(await pl.renamePlaylist(db, p.id, `\t${"y".repeat(300)}\n`)).toBe(true);
    expect((await pl.getPlaylist(db, p.id))!.name).toBe("y".repeat(PLAYLIST_NAME_MAX));
    await expect(pl.renamePlaylist(db, p.id, "\r\n")).rejects.toBeInstanceOf(pl.PlaylistNameError);
    expect((await pl.getPlaylist(db, p.id))!.name).toBe("y".repeat(PLAYLIST_NAME_MAX));
  });
});
