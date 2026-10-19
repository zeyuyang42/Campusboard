import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { decodeEntities } from "../src/scrape/html.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ChallengeGate } from "../src/scrape/challenge.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { CollectionRefresher } from "../src/services/collectionRefresh.js";
import { getAccount, setIdentityCookie, setUsername, clearAccount, SYNC_KEY } from "../src/services/account.js";
import { getSetting, setSetting } from "../src/db/repos/settings.js";
import { listAlbums } from "../src/db/repos/albums.js";
import * as jobs from "../src/db/repos/jobs.js";
import { createCore } from "../src/core.js";
import {
  COLLECTION_REFRESH_INTERVAL_MS, COLLECTION_REFRESH_LAST_KEY, COLLECTION_REFRESH_SETTING_KEY, COLLECTION_REFRESH_START_DELAY_MS, COLLECTION_REFRESH_TICK_MS, RATE_LIMIT_MS,
} from "../src/config.js";
import type { SyncSummary } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (name: string) => readFileSync(path.join(here, "fixtures", `${name}.json`), "utf8");

const FAN = "https://bandcamp.com/examplefan";
const COLLECTION_API = "https://bandcamp.com/api/fancollection/1/collection_items";
const WISHLIST_API = "https://bandcamp.com/api/fancollection/1/wishlist_items";
const ALBUM = "https://illuminatihotties.bandcamp.com/album/let-me-do-one-more";
const TRACK = "https://illuminatihotties.bandcamp.com/track/pool-hopping";
const CUSTOM_ALBUM_SUB = "https://zoekeating.bandcamp.com/album/snowmelt-ep";
const COOKIE = "7%09abcDEF%3D%3D%09%7B%22id%22%3A1%7D";
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-19T08:00:00Z").getTime();

type Blob = Record<string, any>;
function fanPage(edit: (b: Blob) => void = () => {}): string {
  const html = fixture("fan");
  const m = html.match(/data-blob="([^"]*)"/)!;
  const b = JSON.parse(decodeEntities(m[1])) as Blob;
  edit(b);
  const attr = JSON.stringify(b).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(m[0], `data-blob="${attr}"`);
}
const loggedInAsFan = (b: Blob) => { b.identities.fan = { id: b.fan_data.fan_id, username: b.fan_data.username }; b.fan_data.is_own_page = true; };

interface Call { url: string; at: number; cookie: string | null }

let db: NodeDb;
let gate: ChallengeGate;
let calls: Call[];
let routes: Record<string, () => string>;

function setup(gapMs = 0, opts: ConstructorParameters<typeof CollectionRefresher>[3] = {}) {
  calls = [];
  routes = {
    [FAN]: () => fanPage(),
    [COLLECTION_API]: () => json("fan-collection-items"),
    [WISHLIST_API]: () => json("fan-wishlist-items"),
    [ALBUM]: () => fixture("album"),
    [TRACK]: () => fixture("track"),
    [CUSTOM_ALBUM_SUB]: () => fixture("custom-album"),
  };
  const fetch = async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, at: Date.now(), cookie: h.Cookie ?? null });
    const r = routes[url];
    return r ? new Response(r(), { status: 200 }) : new Response("not here", { status: 404 });
  };
  gate = new ChallengeGate();
  const queue = new FetchQueue(fetch, gapMs, gate);
  const runner = new JobRunner(db, queue);
  const refresher = new CollectionRefresher(db, gate, runner, opts);
  return { runner, refresher };
}

const collectionJobs = () => db.raw.prepare("SELECT id, status FROM jobs WHERE kind = 'collection' ORDER BY id").all() as { id: number; status: string }[];

/** Let timers run until the job has finished (fake time moves with it). */
async function finish(jobId: number, stepMs = 50): Promise<string> {
  for (let i = 0; i < 2000; i++) {
    const s = await jobs.jobStatus(db, jobId);
    if (s !== "queued" && s !== "running" && s !== "pending") return s!;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error("job did not finish");
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  db = new NodeDb();
});
afterEach(() => { vi.useRealTimers(); });

describe("background collection refresh", () => {
  it("waits a few minutes after launch, then runs one sync at 1 request per second, never a burst", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup(RATE_LIMIT_MS);
    refresher.start();
    await vi.advanceTimersByTimeAsync(COLLECTION_REFRESH_START_DELAY_MS - 1);
    expect(calls).toEqual([]);
    expect(collectionJobs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const [job] = collectionJobs();
    expect(job).toBeDefined();
    expect(await finish(job.id, 200)).toBe("done");
    // Fan page, both lists, then the missing releases: serial, at least a second apart.
    expect(calls[0].url).toBe(FAN);
    expect(calls.length).toBeGreaterThan(3);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(RATE_LIMIT_MS);
    expect((await listAlbums(db, "title", "purchased")).length).toBe(2);
    refresher.stop();
  });

  it("runs at most once per 24 hours while the app stays open", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    refresher.start();
    await vi.advanceTimersByTimeAsync(COLLECTION_REFRESH_START_DELAY_MS);
    await finish(collectionJobs()[0].id);
    const started = (await refresher.status()).last_auto_at!;
    expect(started).toBe(T0 + COLLECTION_REFRESH_START_DELAY_MS);
    // Many ticks later, still within the day: nothing new.
    await vi.advanceTimersByTimeAsync(COLLECTION_REFRESH_INTERVAL_MS - 2 * COLLECTION_REFRESH_TICK_MS);
    expect(collectionJobs()).toHaveLength(1);
    // The first tick at or after 24 h starts the next one.
    await vi.advanceTimersByTimeAsync(2 * COLLECTION_REFRESH_TICK_MS);
    expect(collectionJobs()).toHaveLength(2);
    expect((await refresher.status()).last_auto_at! - started).toBeGreaterThanOrEqual(COLLECTION_REFRESH_INTERVAL_MS);
    expect((await refresher.status()).last_auto_at! - started).toBeLessThan(COLLECTION_REFRESH_INTERVAL_MS + COLLECTION_REFRESH_TICK_MS);
    refresher.stop();
  });

  it("counts a manual sync: none until 24 hours after the last sync of any kind", async () => {
    await setUsername(db, "examplefan");
    const { runner, refresher } = setup();
    await finish((await runner.enqueueSync()).id);
    const at = Date.parse((await getSetting<SyncSummary>(db, SYNC_KEY))!.at);
    expect(await refresher.tick(at + COLLECTION_REFRESH_INTERVAL_MS - 1)).toEqual({ skipped: "not_due" });
    expect(await refresher.tick(at + COLLECTION_REFRESH_INTERVAL_MS)).toMatchObject({ job_id: expect.any(Number) });
  });

  it("skips while the setting is off, without an account, during a job and during a challenge cooldown", async () => {
    const { refresher } = setup();
    expect(await refresher.tick()).toEqual({ skipped: "no_account" });
    await setUsername(db, "examplefan");

    await refresher.setEnabled(false);
    expect(await refresher.tick()).toEqual({ skipped: "off" });
    await refresher.setEnabled(true);

    const imp = await jobs.createJob(db, "album", ALBUM, [ALBUM]);
    // createJob leaves it queued; the runner never started here, so it stays put.
    expect(await refresher.tick()).toEqual({ skipped: "job" });
    await jobs.transitionJob(db, imp.id, ["queued"], "cancelled");

    await gate.trip();
    expect(await refresher.tick()).toEqual({ skipped: "cooldown" });
    await vi.advanceTimersByTimeAsync(gate.until()! - Date.now() + 1);

    expect(calls).toEqual([]);
    expect(collectionJobs()).toEqual([]);
    expect(await refresher.tick()).toMatchObject({ job_id: expect.any(Number) });
  });

  it("is on by default and keeps the last run when toggled", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    expect(await refresher.status()).toEqual({ enabled: true, last_auto_at: null });
    await refresher.tick();
    await refresher.setEnabled(false);
    expect(await refresher.status()).toEqual({ enabled: false, last_auto_at: T0 });
    expect(await getSetting(db, COLLECTION_REFRESH_SETTING_KEY)).toEqual({ enabled: false });
    expect(await getSetting(db, COLLECTION_REFRESH_LAST_KEY)).toBe(T0);
  });

  it("a toggle during a tick is never undone by the tick's write", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    // Turn it off while the tick is between its checks and its write.
    const pending = refresher.tick();
    await refresher.setEnabled(false);
    await pending;
    expect((await refresher.status()).enabled).toBe(false);
    expect((await refresher.status()).last_auto_at).not.toBeNull();
    // And the other way round: a toggle after a run keeps the run time.
    await refresher.setEnabled(true);
    expect((await refresher.status()).last_auto_at).toBe(T0);
  });

  it("treats a last run in the future (clock moved back) as due", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    await setSetting(db, COLLECTION_REFRESH_LAST_KEY, T0 + 30 * 24 * HOUR);
    expect(await refresher.tick()).toMatchObject({ job_id: expect.any(Number) });
  });

  it("Remove account forgets the last automatic run, so a new account doesn't wait a day", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    await refresher.tick();
    await clearAccount(db);
    expect((await refresher.status()).last_auto_at).toBeNull();
    expect((await refresher.status()).enabled).toBe(true);
  });

  it("a failed refresh isn't retried until the next interval", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    delete routes[FAN]; // 404
    const r = await refresher.tick();
    expect(await finish((r as { job_id: number }).job_id)).toBe("failed");
    const n = calls.length;
    expect(n).toBeGreaterThan(0);
    vi.setSystemTime(T0 + 6 * HOUR);
    expect(await refresher.tick()).toEqual({ skipped: "not_due" });
    expect(calls).toHaveLength(n);
  });

  it("with a cookie Bandcamp rejected: reads the public lists without it, removes nothing, keeps the status", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, COOKIE);
    const { runner, refresher } = setup();
    let signedIn = true;
    routes[FAN] = () => signedIn ? fanPage(loggedInAsFan) : fanPage((b) => {
      // Signed out the private collection looks empty.
      b.collection_data = { ...b.collection_data, item_count: 0, sequence: [], last_token: null };
    });
    await finish((await runner.enqueueSync()).id);
    expect((await listAlbums(db, "title", "purchased")).length).toBe(2);
    signedIn = false;
    vi.setSystemTime(T0 + 1000);
    await finish((await runner.enqueueSync()).id); // manual: offers the cookie, finds it rejected
    expect((await getAccount(db)).lastSync).toMatchObject({ cookie: "rejected", authenticated: true });

    calls.length = 0;
    const r = await refresher.tick(Date.now() + COLLECTION_REFRESH_INTERVAL_MS);
    expect(await finish((r as { job_id: number }).job_id)).toBe("done");
    expect(calls[0].url).toBe(FAN);
    expect(calls.every((c) => c.cookie === null)).toBe(true);
    expect((await listAlbums(db, "title", "purchased")).length).toBe(2);
    expect((await getAccount(db)).lastSync).toMatchObject({ cookie: "rejected", complete: false, authenticated: true });
  });

  it("with an accepted cookie: sends it to bandcamp.com only, like Sync now", async () => {
    await setUsername(db, "examplefan");
    await setIdentityCookie(db, COOKIE);
    const { refresher } = setup();
    routes[FAN] = () => fanPage(loggedInAsFan);
    const r = await refresher.tick();
    expect(await finish((r as { job_id: number }).job_id)).toBe("done");
    expect(calls[0]).toMatchObject({ url: FAN, cookie: `identity=${COOKIE}` });
    for (const c of calls) if (c.cookie) expect(new URL(c.url).hostname.endsWith("bandcamp.com")).toBe(true);
    expect((await getAccount(db)).lastSync).toMatchObject({ cookie: "ok", complete: true });
  });

  it("stops looking once the account is removed", async () => {
    await setUsername(db, "examplefan");
    const { refresher } = setup();
    await clearAccount(db);
    expect(await refresher.tick()).toEqual({ skipped: "no_account" });
    expect(calls).toEqual([]);
  });

  it("is not started by createCore", async () => {
    await setUsername(db, "examplefan");
    await setSetting(db, COLLECTION_REFRESH_SETTING_KEY, {});
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    const core = createCore({ db, fetch });
    await vi.advanceTimersByTimeAsync(COLLECTION_REFRESH_START_DELAY_MS + COLLECTION_REFRESH_TICK_MS);
    expect(fetch).not.toHaveBeenCalled();
    core.stopCollectionRefresh();
    core.stopReleaseChecks();
  });
});
