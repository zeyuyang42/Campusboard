import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { upsertTralbum } from "../src/services/importService.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ChallengeGate } from "../src/scrape/challenge.js";
import { ReleaseChecker } from "../src/services/releaseWatch.js";
import { getAlbumWithTracks, nextDuePreorder } from "../src/db/repos/albums.js";
import { PREORDER_RECHECK_GRACE_MS, preorderRecheckDue, releaseTime } from "../src/services/preorder.js";
import { RELEASE_CHECK_INTERVAL_MS } from "../src/config.js";

// Saved 2026-10-19: a pre-order released 30 Oct 2026 with 3 of 15 tracks out early.
const URL = "https://pisstheband.bandcamp.com/album/you-made-me-skin-on-linen";
const RELEASE = Date.UTC(2026, 9, 30);
const HOUR = 60 * 60 * 1000;

/** The same page after release day: no longer a pre-order, every track with a stream. */
function released(): string {
  return fixture("preorder")
    .replace("&quot;is_preorder&quot;:true", "&quot;is_preorder&quot;:false")
    .replace("&quot;album_is_preorder&quot;:true", "&quot;album_is_preorder&quot;:false")
    .replaceAll("&quot;file&quot;:null", "&quot;file&quot;:{&quot;mp3-128&quot;:&quot;https://t4.bcbits.com/stream/abc/mp3-128/1?p=0&amp;ts=1893456000&quot;}")
    .replaceAll("&quot;unreleased_track&quot;:true", "&quot;unreleased_track&quot;:false");
}

describe("pre-order page (fixture)", () => {
  const p = parseTralbumPage(fixture("preorder"), 0);
  it("is a pre-order with its release date", () => {
    expect(p.is_preorder).toBe(true);
    expect(p.release_date).toBe("30 Oct 2026 00:00:00 GMT");
    expect(releaseTime(p.release_date)).toBe(RELEASE);
  });
  it("has only the tracks that are out as streamable", () => {
    expect(p.tracks).toHaveLength(15);
    expect(p.tracks.filter((t) => t.streamable).map((t) => t.track_num)).toEqual([4, 11, 14]);
    for (const t of p.tracks.filter((t) => !t.streamable)) expect(t.stream_url).toBeNull();
  });
});

describe("releaseTime", () => {
  it("reads Bandcamp's format in UTC and falls back to Date.parse", () => {
    expect(releaseTime("01 Oct 2021 00:00:00 GMT")).toBe(Date.UTC(2021, 9, 1));
    expect(releaseTime("5 May 2020")).toBe(Date.UTC(2020, 4, 5));
    expect(releaseTime("2024-02-03T00:00:00Z")).toBe(Date.UTC(2024, 1, 3));
    expect(releaseTime("soon")).toBeNull();
    expect(releaseTime(null)).toBeNull();
  });
});

describe("preorderRecheckDue", () => {
  const base = { is_preorder: true, release_date: "30 Oct 2026 00:00:00 GMT", fetched_at: "2026-10-19 10:00:00" };
  const due = RELEASE + PREORDER_RECHECK_GRACE_MS;
  it("waits for the release date plus the grace", () => {
    expect(preorderRecheckDue(base, RELEASE)).toBe(false);
    expect(preorderRecheckDue(base, due - 1)).toBe(false);
    expect(preorderRecheckDue(base, due)).toBe(true);
  });
  it("is settled by one fetch after that point", () => {
    expect(preorderRecheckDue({ ...base, fetched_at: "2026-10-30 12:00:00" }, due + HOUR)).toBe(false);
    expect(preorderRecheckDue({ ...base, fetched_at: "2026-10-30 06:00:00" }, due + HOUR)).toBe(true);
  });
  it("needs a pre-order with a readable date", () => {
    expect(preorderRecheckDue({ ...base, is_preorder: false }, due)).toBe(false);
    expect(preorderRecheckDue({ ...base, release_date: null }, due)).toBe(false);
  });
});

describe("re-checking pre-orders after release (#37)", () => {
  let db: NodeDb;
  let albumId: number;
  let bodies: Record<string, string>;
  let calls: string[];
  let checker: ReleaseChecker;

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 19, 12), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    db = new NodeDb();
    albumId = await upsertTralbum(db, parseTralbumPage(fixture("preorder")));
    bodies = {};
    calls = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = bodies[url];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
    };
    checker = new ReleaseChecker(db, new FetchQueue(fetch, 0, new ChallengeGate()));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("leaves a pre-order alone before its release date", async () => {
    expect(await nextDuePreorder(db, Date.now())).toBeNull();
    const r = await checker.tick();
    expect(r).not.toHaveProperty("status", "preorder");
    expect(calls).not.toContain(URL);
  });

  it("fetches it once after release, and its tracks become playable", async () => {
    bodies[URL] = released();
    vi.setSystemTime(RELEASE + PREORDER_RECHECK_GRACE_MS + HOUR);
    const r = await checker.tick();
    expect(r).toEqual({ album_id: albumId, status: "preorder", released: true, streamable_before: 3, streamable_after: 15 });
    expect(calls).toEqual([URL]);
    const a = (await getAlbumWithTracks(db, albumId))!;
    expect(a.is_preorder).toBe(false);
    expect(a.tracks.every((t) => t.streamable)).toBe(true);
    // Settled: the next tick goes on to the artist check instead.
    expect(await nextDuePreorder(db, Date.now())).toBeNull();
    await checker.tick();
    expect(calls.filter((u) => u === URL)).toHaveLength(1);
  });

  it("asks only once if Bandcamp still lists it as a pre-order", async () => {
    bodies[URL] = fixture("preorder");
    vi.setSystemTime(RELEASE + PREORDER_RECHECK_GRACE_MS + HOUR);
    const r = await checker.tick();
    expect(r).toMatchObject({ status: "preorder", released: false, streamable_after: 3 });
    expect(await nextDuePreorder(db, Date.now() + 10 * 24 * HOUR)).toBeNull();
  });

  it("waits a day after a failed fetch", async () => {
    vi.setSystemTime(RELEASE + PREORDER_RECHECK_GRACE_MS + HOUR);
    const r = await checker.tick();
    expect(r).toMatchObject({ status: "preorder", released: false });
    expect((r as { error?: string }).error).toBeTruthy();
    expect(calls).toEqual([URL]); // no retries
    await checker.tick();
    expect(calls.filter((u) => u === URL)).toHaveLength(1);
    bodies[URL] = released();
    vi.setSystemTime(Date.now() + RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ status: "preorder", released: true });
  });
});
