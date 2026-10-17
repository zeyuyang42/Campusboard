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
