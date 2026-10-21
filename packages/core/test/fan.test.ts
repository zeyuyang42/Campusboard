import { describe, it, expect, beforeEach } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fanPage, fixture, jsonFixture as json, loggedInAsFan } from "./helpers.js";
import {
  fanItemFetchUrl, fetchFanList, mayCarryIdentity, normalizeFanUsername, parseFanItemsResponse, parseFanPage, FAN_MAX_PAGES,
} from "../src/scrape/fan.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { FetchQueue } from "../src/scrape/http.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { clearAccount, getAccount, identityHeaders, normalizeIdentityCookie, setIdentityCookie, setUsername, IDENTITY_KEY } from "../src/services/account.js";
import { refreshAlbum } from "../src/services/streamService.js";
import { listAlbums } from "../src/db/repos/albums.js";
import { getSetting } from "../src/db/repos/settings.js";
import * as jobs from "../src/db/repos/jobs.js";
import type { Db } from "../src/db/Db.js";
import { createCore } from "../src/core.js";
import type { Job } from "../src/types.js";

const FAN = "https://bandcamp.com/examplefan";
const COLLECTION_API = "https://bandcamp.com/api/fancollection/1/collection_items";
const WISHLIST_API = "https://bandcamp.com/api/fancollection/1/wishlist_items";
const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const TRACK = "https://illuminatihotties.bandcamp.com/track/pool-hopping";
const CUSTOM_ALBUM = "https://music.zoekeating.com/album/snowmelt-ep";
const CUSTOM_ALBUM_SUB = "https://zoekeating.bandcamp.com/album/snowmelt-ep";
const COOKIE = "7%09abcDEF%3D%3D%09%7B%22id%22%3A1%7D";

/** An album page whose tracks also offer mp3-v0, as logged-in pages for owned items do. */
const withV0 = (html: string) => html.replace(/&quot;file&quot;:\{&quot;mp3-128&quot;:&quot;(https:\/\/t4\.bcbits\.com\/stream\/[^/]+)\/mp3-128\/(\d+)\?p=0&amp;ts=(\d+)/g,
  (whole, base, id, ts) => `&quot;file&quot;:{&quot;mp3-v0&quot;:&quot;${base}/mp3-v0/${id}?p=0&amp;ts=${ts}&amp;t=v0&quot;,&quot;mp3-128&quot;:&quot;${base}/mp3-128/${id}?p=0&amp;ts=${ts}`);

interface Call { url: string; method: string; cookie: string | null; body: string | null }

type Route = string | (() => string | Promise<string>);
/** A fake Bandcamp serving the fixtures; `routes` overrides or adds bodies by URL. */
function fakeBandcamp(routes: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const base: Record<string, Route> = {
    [FAN]: () => fanPage(),
    [COLLECTION_API]: () => json("fan-collection-items"),
    [WISHLIST_API]: () => json("fan-wishlist-items"),
    [ALBUM]: () => fixture("album"),
    [TRACK]: () => fixture("track"),
    [CUSTOM_ALBUM_SUB]: () => fixture("custom-album"),
  };
  const all = { ...base, ...routes };
  const fetch = async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", cookie: h.Cookie ?? null, body: (init.body as string) ?? null });
    const r = all[url];
    if (r === undefined) return new Response("not here", { status: 404 });
    return new Response(typeof r === "function" ? await r() : r, { status: 200 });
  };
  return { fetch, calls };
}

async function runSync(db: Db, runner: JobRunner): Promise<Job> {
  const job = await runner.enqueueSync();
  for (let i = 0; i < 200; i++) {
    const j = (await jobs.getJob(db, job.id))!;
    if (j.status !== "queued" && j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("sync did not finish");
}

let db: NodeDb;
beforeEach(() => { db = new NodeDb(); });

describe("fan page and list parsing", () => {
  it("reads the fan id, counts, first batches and paging tokens from the page", () => {
    const p = parseFanPage(fixture("fan"));
    expect(p).toMatchObject({ fan_id: 1000001, username: "examplefan", logged_in: false, own_page: false });
    expect(p.collection.items.map((i) => i.url)).toEqual([ALBUM]);
    expect(p.collection).toMatchObject({ count: 2, more: true, next: "1700000001:3637872805:a::" });
    // The wishlist tab isn't open, so its first batch is in pending_sequence.
    expect(p.wishlist.items).toEqual([expect.objectContaining({ item_type: "track", bandcamp_id: 282506895, url: TRACK, fetch_url: TRACK })]);
    expect(p.wishlist.more).toBe(false);
  });

  it("recognises a page fetched with a cookie Bandcamp accepted", () => {
    expect(parseFanPage(fanPage(loggedInAsFan))).toMatchObject({ logged_in: true, own_page: true });
    expect(parseFanPage(fanPage((b) => { b.identities.fan = { id: 5 }; }))).toMatchObject({ logged_in: true, own_page: false });
  });

  it("rejects pages that aren't fan pages and the bot check", () => {
    expect(() => parseFanPage(fixture("album"))).toThrow(expect.objectContaining({ code: "parse_failed" }));
    expect(() => parseFanPage(fixture("challenge"))).toThrow(expect.objectContaining({ code: "client_challenge" }));
  });

  it("maps custom-domain items to their bandcamp.com subdomain and keeps the canonical URL", () => {
    const page = parseFanItemsResponse(json("fan-collection-items"));
    expect(page.items).toEqual([expect.objectContaining({ item_type: "album", bandcamp_id: 2164502333, url: CUSTOM_ALBUM, fetch_url: CUSTOM_ALBUM_SUB })]);
    expect(page.more).toBe(false);
  });

  it("reads a live-shaped wishlist response; a track's url_hints slug (its album) is not used", () => {
    const page = parseFanItemsResponse(json("fan-wishlist-items"));
    expect(page.items.map((i) => [i.item_type, i.fetch_url])).toEqual([
      ["track", "https://whiteward.bandcamp.com/track/when-gift-becomes-damnation-3"],
      ["album", "https://mypetflamingo.bandcamp.com/album/after-hours"],
    ]);
    expect(page.next).toBe("1700000002:658791445:a::");
  });

  it("pages on from the last item's token, not last_token, and reports errors", () => {
    const body = JSON.parse(json("fan-collection-items"));
    body.more_available = true;
    body.last_token = "1:20th:a::";
    body.items[0].token = "1:last:a::";
    expect(parseFanItemsResponse(JSON.stringify(body))).toMatchObject({ more: true, next: "1:last:a::" });
    expect(() => parseFanItemsResponse('{"error":true,"error_message":"nope"}')).toThrow(expect.objectContaining({ code: "fetch_failed" }));
    expect(() => parseFanItemsResponse("<html>")).toThrow(expect.objectContaining({ code: "parse_failed" }));
  });

  it("drops entries that aren't albums or tracks, or whose URLs aren't Bandcamp-shaped", () => {
    const body = JSON.parse(json("fan-collection-items"));
    const good = body.items[0];
    body.items = [
      { ...good, tralbum_type: "p" },
      { ...good, item_url: "http://192.168.1.1/album/x", url_hints: { subdomain: "x" } },
      { ...good, url_hints: { subdomain: "evil.example.com/" } },
      { ...good, item_url: "https://x.bandcamp.com/music" },
      good,
    ];
    expect(parseFanItemsResponse(JSON.stringify(body)).items).toHaveLength(1);
  });

  it("normalises usernames and refuses anything else", () => {
    expect(normalizeFanUsername(" examplefan ")).toBe("examplefan");
    expect(normalizeFanUsername("https://bandcamp.com/example_fan-2/wishlist")).toBe("example_fan-2");
    expect(normalizeFanUsername("bandcamp.com/examplefan")).toBe("examplefan");
    for (const bad of ["", "a b", "../api", "name.bandcamp.com", "x".repeat(65)]) {
      expect(() => normalizeFanUsername(bad)).toThrow(expect.objectContaining({ code: "invalid_username" }));
    }
  });

  it("only lets the identity cookie go to https bandcamp.com hosts", () => {
    for (const ok of ["https://bandcamp.com/x", "https://name.bandcamp.com/album/y"]) expect(mayCarryIdentity(ok)).toBe(true);
    for (const no of ["http://bandcamp.com/x", "https://music.zoekeating.com/album/y", "https://bandcamp.com.evil.net/", "https://evilbandcamp.com/", "https://bandcamp.com:8443/", "https://f4.bcbits.com/img/1.jpg"]) {
      expect(mayCarryIdentity(no)).toBe(false);
    }
    expect(fanItemFetchUrl("https://music.zoekeating.com/album/snowmelt-ep", "zoekeating")).toBe(CUSTOM_ALBUM_SUB);
    expect(fanItemFetchUrl("https://music.zoekeating.com/album/snowmelt-ep", null)).toBeNull();
  });
});

describe("identity cookie input", () => {
  it("accepts the value, identity=value or a whole Cookie header", () => {
    expect(normalizeIdentityCookie(COOKIE)).toBe(COOKIE);
    expect(normalizeIdentityCookie(` identity=${COOKIE} `)).toBe(COOKIE);
    expect(normalizeIdentityCookie(`client_id=abc; identity=${COOKIE}; js_logged_in=1`)).toBe(COOKIE);
  });

  it("rejects what can't be one cookie value without echoing it", () => {
    for (const bad of ["", "two words", "a;b", "a\nb", `client_id=abc; other=1`, "x".repeat(5000)]) {
      const err = (() => { try { normalizeIdentityCookie(bad); } catch (e) { return e as Error & { code: string }; } })();
      expect(err?.code).toBe("invalid_cookie");
      if (bad.length > 3) expect(err!.message).not.toContain(bad);
    }
  });
});

describe("fetchFanList", () => {
  const page = () => parseFanPage(fixture("fan")).collection;

  it("stops when a page brings nothing new instead of looping", async () => {
    const body = JSON.parse(json("fan-collection-items"));
    body.more_available = true;
    let n = 0;
    const r = await fetchFanList(async () => { n++; return JSON.stringify(body); }, 1, "collection", page());
    expect(n).toBe(2);
    expect(r).toMatchObject({ complete: false });
    expect(r.items).toHaveLength(2);
  });

  it("calls a list incomplete when Bandcamp sent fewer entries than it announced", async () => {
    const first = { ...page(), more: false };
    expect((await fetchFanList(async () => "", 1, "collection", first)).complete).toBe(false);
    expect((await fetchFanList(async () => "", 1, "collection", { ...first, count: 1 })).complete).toBe(true);
  });

  it("gives up after FAN_MAX_PAGES and says the list is incomplete", async () => {
    let n = 0;
    const r = await fetchFanList(async () => {
      n++;
      const body = JSON.parse(json("fan-collection-items"));
      body.more_available = true;
      body.items[0] = { ...body.items[0], tralbum_id: n, item_url: `https://x.bandcamp.com/album/a${n}`, token: `t${n}` };
      return JSON.stringify(body);
    }, 1, "collection", page());
    expect(n).toBe(FAN_MAX_PAGES);
    expect(r.complete).toBe(false);
  });
});

describe("collection sync", () => {
  function setup(routes?: Record<string, Route>) {
    const f = fakeBandcamp(routes);
    const runner = new JobRunner(db, new FetchQueue(f.fetch, 0));
    return { ...f, runner };
  }

  it("needs a username", async () => {
    const { runner } = setup();
    await expect(runner.enqueueSync()).rejects.toMatchObject({ code: "no_account" });
  });

  it("imports purchases and the wishlist without a cookie, flags them, and skips what the library has", async () => {
    await setUsername(db, "examplefan");
    const { runner, calls } = setup();
    const job = await runSync(db, runner);
    expect(job).toMatchObject({ kind: "collection", status: "done", total: 3, done: 3, failed: 0 });
    expect(calls.every((c) => c.cookie === null)).toBe(true);
    // The custom-domain purchase is fetched at its bandcamp.com subdomain; the wishlisted
    // track arrived with the purchased album, so its page isn't fetched.
    expect(calls.map((c) => c.url)).toEqual([FAN, COLLECTION_API, ALBUM, CUSTOM_ALBUM_SUB]);
    expect(JSON.parse(calls[1].body!)).toEqual({ fan_id: 1000001, older_than_token: "1700000001:3637872805:a::", count: 100 });
    const purchased = await listAlbums(db, "title", "purchased");
    expect(purchased.map((a) => a.url).sort()).toEqual([ALBUM, CUSTOM_ALBUM]);
    expect(purchased.every((a) => a.owned)).toBe(true);
    expect((await getAccount(db)).lastSync).toMatchObject({ username: "examplefan", collection: 2, wishlist: 1, queued: 3, complete: true, cookie: "none" });

    // A second sync finds everything in place and fetches only the lists.
    calls.length = 0;
    const again = await runSync(db, runner);
    expect(again).toMatchObject({ status: "done", total: 0, error: expect.stringContaining("already in your library") });
    expect(calls.map((c) => c.url)).toEqual([FAN, COLLECTION_API]);
  });

  it("shows wishlisted items under the wishlist filter", async () => {
    await setUsername(db, "examplefan");
    // Only the custom album is purchased: the wishlisted track becomes its own entry.
    const { runner } = setup({ [FAN]: () => fanPage((b) => { b.collection_data.sequence = []; b.collection_data.item_count = 1; }) });
    expect(await runSync(db, runner)).toMatchObject({ status: "done", done: 2 });
    const wish = await listAlbums(db, "title", "wishlist");
    expect(wish.map((a) => [a.url, a.wishlisted, a.owned])).toEqual([[TRACK, true, false]]);
    expect((await listAlbums(db, "title", "all"))).toHaveLength(2);
  });

  it("clears flags for items that left the collection, only after a complete read", async () => {
    await setUsername(db, "examplefan");
    let collection = json("fan-collection-items");
    let fanBody = fanPage();
    const { runner } = setup({ [COLLECTION_API]: () => collection, [FAN]: () => fanBody });
    await runSync(db, runner);
    expect((await listAlbums(db, "title", "purchased"))).toHaveLength(2);

    // The API fails halfway: the job fails and nothing changes.
    collection = "<html><title>Oops</title></html>";
    expect(await runSync(db, runner)).toMatchObject({ status: "failed" });
    expect((await listAlbums(db, "title", "purchased"))).toHaveLength(2);

    // A private-looking read (the page announces 2, only 1 arrives) clears nothing either.
    collection = JSON.stringify({ ...JSON.parse(json("fan-collection-items")), items: [] });
    expect(await runSync(db, runner)).toMatchObject({ status: "done" });
    expect((await listAlbums(db, "title", "purchased"))).toHaveLength(2);
    expect((await getAccount(db)).lastSync).toMatchObject({ complete: false });

    // Read in full without the custom album: its flag goes, the album stays in the library.
    fanBody = fanPage((b) => { b.collection_data.item_count = 1; });
    expect(await runSync(db, runner)).toMatchObject({ status: "done" });
    expect((await listAlbums(db, "title", "purchased")).map((a) => a.url)).toEqual([ALBUM]);
    expect(await listAlbums(db)).toHaveLength(2);
    expect((await getAccount(db)).lastSync).toMatchObject({ collection: 1 });
  });

  it("sends an accepted cookie only to bandcamp.com and purchases, and stores mp3-v0 streams", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, `identity=${COOKIE}`);
    const { runner, calls } = setup({
      [FAN]: () => fanPage((b) => { loggedInAsFan(b); b.collection_data.sequence = []; b.collection_data.item_count = 1; }),
      [CUSTOM_ALBUM_SUB]: () => withV0(fixture("custom-album")),
    });
    const job = await runSync(db, runner);
    expect(job).toMatchObject({ status: "done", done: 2, error: null });
    const by = Object.fromEntries(calls.map((c) => [c.url, c.cookie]));
    expect(by[FAN]).toBe(`identity=${COOKIE}`);
    expect(by[COLLECTION_API]).toBe(`identity=${COOKIE}`);
    expect(by[CUSTOM_ALBUM_SUB]).toBe(`identity=${COOKIE}`);
    expect(by[TRACK]).toBeNull(); // wishlist, not a purchase
    expect(calls.some((c) => c.url.startsWith("https://music.zoekeating.com"))).toBe(false);
    const q = await db.select<{ stream_quality: string; stream_url: string }>(
      "SELECT t.stream_quality, t.stream_url FROM tracks t JOIN albums a ON a.id = t.album_id WHERE a.url = ? AND t.streamable = 1", [CUSTOM_ALBUM]);
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((r) => r.stream_quality === "mp3-v0" && r.stream_url.includes("/mp3-v0/"))).toBe(true);
    expect((await getAccount(db)).lastSync?.cookie).toBe("ok");

    // Refreshing the purchase goes to the subdomain with the cookie, never the custom domain.
    const a = (await listAlbums(db)).find((x) => x.url === CUSTOM_ALBUM)!;
    const r = fakeBandcamp({ [CUSTOM_ALBUM_SUB]: () => withV0(fixture("custom-album")), [CUSTOM_ALBUM]: () => fixture("custom-album") });
    await refreshAlbum(db, new FetchQueue(r.fetch, 0), a.id, a.url);
    expect(r.calls).toEqual([expect.objectContaining({ url: CUSTOM_ALBUM_SUB, cookie: `identity=${COOKIE}` })]);
    // Without the cookie the stored (custom-domain) URL is used, as for any album.
    await setIdentityCookie(db, null);
    r.calls.length = 0;
    await refreshAlbum(db, new FetchQueue(r.fetch, 0), a.id, a.url);
    expect(r.calls).toEqual([expect.objectContaining({ url: CUSTOM_ALBUM, cookie: null })]);
  });

  it("stops using a cookie Bandcamp didn't accept and says so", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, COOKIE);
    const { runner, calls } = setup({ [FAN]: () => fanPage((b) => { b.collection_data.sequence = []; b.collection_data.item_count = 1; }) });
    const job = await runSync(db, runner);
    expect(job).toMatchObject({ status: "done", error: expect.stringContaining("didn't accept the identity cookie") });
    expect(calls[0]).toMatchObject({ url: FAN, cookie: `identity=${COOKIE}` });
    expect(calls.slice(1).every((c) => c.cookie === null)).toBe(true);
    expect((await getAccount(db)).lastSync?.cookie).toBe("rejected");
    expect(await identityHeaders(db, CUSTOM_ALBUM_SUB)).toEqual({});
    // A fresh cookie is tried again.
    await setIdentityCookie(db, COOKIE);
    expect(await identityHeaders(db, CUSTOM_ALBUM_SUB)).toEqual({ Cookie: `identity=${COOKIE}` });
    expect(await identityHeaders(db, CUSTOM_ALBUM)).toEqual({});
  });

  it("clearing the account removes the cookie, the lists and the flags", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, COOKIE);
    const { runner } = setup();
    await runSync(db, runner);
    expect((await listAlbums(db, "title", "purchased")).length).toBeGreaterThan(0);
    expect(await clearAccount(db)).toEqual({ username: null, hasCookie: false, lastSync: null });
    expect(await getSetting(db, IDENTITY_KEY)).toBeNull();
    expect(await db.get("SELECT 1 AS x FROM fan_items")).toBeNull();
    expect(await listAlbums(db, "title", "purchased")).toEqual([]);
    expect(await listAlbums(db)).toHaveLength(2); // the albums themselves stay
  });

  it("switching usernames forgets the previous account's lists", async () => {
    await setUsername(db, "examplefan");
    await runSync(db, setup().runner);
    await setUsername(db, "examplefan"); // same account: kept
    expect((await listAlbums(db, "title", "purchased")).length).toBe(2);
    await setUsername(db, "someoneelse");
    expect(await listAlbums(db, "title", "purchased")).toEqual([]);
  });

  it("an expired or removed cookie doesn't empty Purchased when the signed-out view shows nothing", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, COOKIE);
    let signedIn = true;
    const { runner, calls } = setup({
      // Signed in the private collection is visible; signed out it looks empty.
      [FAN]: () => signedIn ? fanPage(loggedInAsFan) : fanPage((b) => {
        b.collection_data = { ...b.collection_data, item_count: 0, sequence: [], last_token: null };
      }),
    });
    expect(await runSync(db, runner)).toMatchObject({ status: "done", error: null });
    expect(await listAlbums(db, "title", "purchased")).toHaveLength(2);

    signedIn = false; // the cookie expired
    calls.length = 0;
    expect(await runSync(db, runner)).toMatchObject({ status: "done" });
    expect(calls[0]).toMatchObject({ url: FAN, cookie: `identity=${COOKIE}` });
    expect(await listAlbums(db, "title", "purchased")).toHaveLength(2);
    expect((await getAccount(db)).lastSync).toMatchObject({ cookie: "rejected", complete: false, authenticated: true });

    // Rejected once is not rejected for good: the fan page still gets the cookie and the
    // next sync finds it working again. Album pages don't get it while it looks rejected.
    expect(await identityHeaders(db, CUSTOM_ALBUM_SUB)).toEqual({});
    calls.length = 0;
    await runSync(db, runner);
    expect(calls[0]).toMatchObject({ url: FAN, cookie: `identity=${COOKIE}` });

    // The user removes the cookie: still signed out, still nothing removed.
    await setIdentityCookie(db, null);
    calls.length = 0;
    await runSync(db, runner);
    expect(calls.every((c) => c.cookie === null)).toBe(true);
    expect(await listAlbums(db, "title", "purchased")).toHaveLength(2);

    // A signed-in sync may remove again.
    await setIdentityCookie(db, COOKIE);
    signedIn = true;
    await runSync(db, runner);
    expect((await getAccount(db)).lastSync).toMatchObject({ cookie: "ok", complete: true });
  });

  it("removing the account mid-sync cancels it and nothing it was about to write comes back", async () => {
    await setUsername(db, "examplefan");
    let release!: () => void;
    let reached!: () => void;
    const atApi = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const { runner, calls } = setup({ [COLLECTION_API]: async () => { reached(); await gate; return json("fan-collection-items"); } });
    const job = await runner.enqueueSync();
    await atApi;
    await clearAccount(db);
    release();
    for (let i = 0; i < 100 && (runner as unknown as { running: boolean }).running; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await jobs.getJob(db, job.id))!.status).toBe("cancelled");
    expect(await db.get("SELECT 1 AS x FROM fan_items")).toBeNull();
    expect((await getAccount(db)).lastSync).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([FAN, COLLECTION_API]);
  });

  it("the listing phase's writes are no-ops once the job is cancelled", async () => {
    await setUsername(db, "examplefan");
    const job = await jobs.createJob(db, "collection", FAN, []);
    await jobs.transitionJob(db, job.id, ["queued"], "cancelled");
    const items = parseFanPage(fixture("fan")).collection.items;
    const { upsertFanItems, removeUnseen } = await import("../src/db/repos/fanItems.js");
    await upsertFanItems(db, "collection", items, job.id);
    expect(await db.get("SELECT 1 AS x FROM fan_items")).toBeNull();
    const { setSettingWhileJobRuns } = await import("../src/db/repos/settings.js");
    expect(await setSettingWhileJobRuns(db, "bandcamp_sync", { x: 1 }, job.id)).toBe(false);
    await removeUnseen(db, "collection", job.id);
  });

  it("changing the username cancels a queued sync of the old one", async () => {
    await setUsername(db, "examplefan");
    const job = await jobs.createJob(db, "collection", FAN, []);
    await setUsername(db, "someoneelse");
    expect((await jobs.getJob(db, job.id))!.status).toBe("cancelled");
  });

  it("doesn't re-import a synced album the user removed, until they import it again", async () => {
    await setUsername(db, "examplefan");
    const { runner, calls } = setup();
    await runSync(db, runner);
    const custom = (await listAlbums(db)).find((a) => a.url === CUSTOM_ALBUM)!;
    const { deleteAlbum } = await import("../src/db/repos/albums.js");
    await deleteAlbum(db, custom.id);
    calls.length = 0;
    expect(await runSync(db, runner)).toMatchObject({ status: "done", total: 0 });
    expect(calls.map((c) => c.url)).toEqual([FAN, COLLECTION_API]);
    // Removing the album holding a wishlisted track dismisses the track too.
    const album = (await listAlbums(db)).find((a) => a.url === ALBUM)!;
    await deleteAlbum(db, album.id);
    calls.length = 0;
    await runSync(db, runner);
    expect(calls.map((c) => c.url)).toEqual([FAN, COLLECTION_API]);
    // Importing it by hand clears the dismissal; it stays marked Purchased.
    const { upsertTralbum } = await import("../src/services/importService.js");
    await upsertTralbum(db, parseTralbumPage(fixture("custom-album"), 0));
    expect(await db.get("SELECT 1 AS x FROM fan_dismissed WHERE bandcamp_id = 2164502333")).toBeNull();
    expect((await listAlbums(db, "title", "purchased")).map((a) => a.url)).toEqual([CUSTOM_ALBUM]);
  });

  it("a sync never cancels a pending removal (#93): the album goes at finish, dismissed", async () => {
    await setUsername(db, "examplefan");
    const { runner, fetch } = setup();
    await runSync(db, runner);
    const custom = (await listAlbums(db)).find((a) => a.url === CUSTOM_ALBUM)!;
    const { markRemoving, removingAlbumIds } = await import("../src/db/repos/albumRemoval.js");
    expect(await markRemoving(db, custom.id)).toBe(true);
    // A sync item for it, as a sync that was running when it was removed would have.
    const { fetch_url } = (await db.get<{ fetch_url: string }>("SELECT fetch_url FROM fan_items WHERE bandcamp_id = 2164502333"))!;
    const job = await jobs.createJob(db, "collection", FAN, [fetch_url]);
    await runner.kick();
    expect((await jobs.getJob(db, job.id))!.status).toBe("done");
    expect(await removingAlbumIds(db)).toEqual([custom.id]);
    // The next start finishes it, and later syncs leave it out.
    const core = createCore({ db, fetch });
    await core.finishAlbumRemovals([]);
    expect(await core.album(custom.id)).toBeNull();
    expect(await db.get("SELECT 1 AS x FROM fan_dismissed WHERE bandcamp_id = 2164502333")).not.toBeNull();
  });

  it("a saved cookie shows as unchecked right away, even after a sync without one", async () => {
    await setUsername(db, "examplefan");
    await runSync(db, setup().runner);
    expect((await getAccount(db)).lastSync?.cookie).toBe("none");
    expect((await setIdentityCookie(db, COOKIE)).lastSync?.cookie).toBe("unchecked");
    expect((await setIdentityCookie(db, null)).lastSync?.cookie).toBe("none");
  });

  it("core's generic settings API refuses the account, cookie and sync status", async () => {
    const core = createCore({ db, fetch: fakeBandcamp().fetch });
    await setIdentityCookie(db, COOKIE);
    for (const key of ["bandcamp_identity", "bandcamp_sync", "bandcamp_account"]) {
      await expect(core.getSetting(key)).rejects.toThrow(/its own functions/);
      await expect(core.setSetting(key, "x")).rejects.toThrow(/its own functions/);
    }
    await core.setSetting("theme", { a: 1 });
    expect(await core.getSetting("theme")).toEqual({ a: 1 });
    expect(await core.account()).toEqual({ username: null, hasCookie: true, lastSync: null });
  });

  it("returns the running sync instead of starting a second one", async () => {
    await setUsername(db, "examplefan");
    const { runner } = setup();
    const a = await runner.enqueueSync();
    const b = await runner.enqueueSync();
    expect(b.id).toBe(a.id);
  });
});

describe("parseTralbum stream quality", () => {
  it("prefers mp3-v0 when the page lists it", () => {
    const p = parseTralbumPage(withV0(fixture("album")), 0);
    expect(p.tracks[0]).toMatchObject({ stream_quality: "mp3-v0", stream_url: expect.stringContaining("/mp3-v0/") });
    expect(parseTralbumPage(fixture("album"), 0).tracks[0].stream_quality).toBe("mp3-128");
  });
});

describe("job runner bookkeeping", () => {
  it("clears a job's force flag when it was cancelled before it started", async () => {
    const f = fakeBandcamp();
    // Cancel the job in the instant before the runner's queued -> running transition.
    const racing: Db = {
      select: (sql, p) => db.select(sql, p),
      run: (sql, p) => db.run(sql, p),
      get: async (sql, p) => {
        if (/^UPDATE jobs SET status/.test(sql) && p?.[0] === "running") await db.run("UPDATE jobs SET status = 'cancelled' WHERE id = ?", [p[3]]);
        return db.get(sql, p);
      },
    };
    const runner = new JobRunner(racing, new FetchQueue(f.fetch, 0));
    await runner.whenReady();
    const job = await runner.enqueue({ url: "https://illuminatihotties.bandcamp.com", force: true });
    for (let i = 0; i < 50 && (runner as unknown as { running: boolean }).running; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await jobs.getJob(db, job.id))!.status).toBe("cancelled");
    expect(f.calls).toHaveLength(0);
    expect((runner as unknown as { forceFlags: Map<number, boolean> }).forceFlags.size).toBe(0);
  });
});
