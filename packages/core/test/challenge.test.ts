import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ChallengeGate, type ChallengeState } from "../src/scrape/challenge.js";
import { ScrapeError } from "../src/scrape/errors.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { cachedFetchText } from "../src/services/pageCache.js";
import { upsertTralbum } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { createCore } from "../src/core.js";
import * as jobs from "../src/db/repos/jobs.js";
import { getSetting, setSetting } from "../src/db/repos/settings.js";
import { CHALLENGE_BACKOFF_MS, CHALLENGE_SETTING_KEY } from "../src/config.js";

const ALBUM_A = "https://someone.bandcamp.com/album/first";
const ALBUM_B = "https://someone.bandcamp.com/album/second";

/** A fetch that serves the given bodies in order (the last one repeats). */
function scriptedFetch(bodies: string[]) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const body = bodies.length > 1 ? bodies.shift()! : bodies[0];
    return new Response(body, { status: 200 });
  };
  return { fetch, calls };
}

const settingsStore = (db: NodeDb) => ({
  load: () => getSetting<ChallengeState>(db, CHALLENGE_SETTING_KEY),
  save: (s: ChallengeState) => setSetting(db, CHALLENGE_SETTING_KEY, s),
});

function setup(db: NodeDb, bodies: string[]) {
  const f = scriptedFetch(bodies);
  const gate = new ChallengeGate(settingsStore(db));
  const queue = new FetchQueue(f.fetch, 0, gate);
  const runner = new JobRunner(db, queue);
  return { ...f, gate, queue, runner };
}

const T0 = new Date("2026-10-17T12:00:00").getTime();
let db: NodeDb;
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date"] });
  db = new NodeDb();
});
afterEach(() => { vi.useRealTimers(); });

describe("challenge backoff", () => {
  it("detects the challenge page in the queue, does not cache it, and starts a cooldown", async () => {
    const { queue, gate } = setup(db, [fixture("challenge")]);
    const err = await cachedFetchText(db, queue, ALBUM_A).catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.code).toBe("client_challenge");
    expect(gate.until()).toBe(T0 + CHALLENGE_BACKOFF_MS);
    expect(await db.get("SELECT url FROM page_cache")).toBeNull();
    expect(await getSetting<ChallengeState>(db, CHALLENGE_SETTING_KEY)).toEqual({ until: T0 + CHALLENGE_BACKOFF_MS, cooldownMs: CHALLENGE_BACKOFF_MS });
  });

  it("pauses the job and retries once after the backoff", async () => {
    const { runner, calls, gate } = setup(db, [fixture("challenge"), fixture("album")]);
    await runner.whenReady();
    const job = await runner.enqueue({ url: ALBUM_A });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(gate.until()).toBe(T0 + CHALLENGE_BACKOFF_MS);
    const paused = (await jobs.getJob(db, job.id))!;
    expect(paused.status).toBe("queued");
    expect(paused.items![0].status).toBe("queued");

    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS);
    expect(calls).toHaveLength(2);
    const done = (await jobs.getJob(db, job.id))!;
    expect(done.status).toBe("done");
    expect(done.done).toBe(1);
    expect(gate.until()).toBeNull();
  });

  it("fails the item when the retry is challenged too, and doubles the cooldown before the next one", async () => {
    const { runner, calls, gate } = setup(db, [fixture("challenge"), fixture("challenge"), fixture("album")]);
    await runner.whenReady();
    const job = await runner.enqueueSelection({ urls: [ALBUM_A, ALBUM_B], label: "two" });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS);
    expect(calls).toEqual([ALBUM_A, ALBUM_A]);
    const mid = (await jobs.getJob(db, job.id))!;
    expect(mid.items![0].status).toBe("failed");
    expect(mid.items![0].error).toMatch(/^\[client_challenge\]/);
    expect(mid.items![1].status).toBe("queued");
    expect(mid.status).toBe("queued"); // paused, not failed
    const extended = (await getSetting<ChallengeState>(db, CHALLENGE_SETTING_KEY))!;
    expect(extended.cooldownMs).toBe(2 * CHALLENGE_BACKOFF_MS);
    expect(gate.until()).toBe(extended.until);

    // Nothing goes out until the doubled cooldown ends.
    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS + 1000);
    expect(calls).toEqual([ALBUM_A, ALBUM_A, ALBUM_B]);
    const end = (await jobs.getJob(db, job.id))!;
    expect(end.status).toBe("done");
    expect([end.done, end.failed]).toEqual([1, 1]);
  });

  it("keeps the challenge reason on a job whose only item was challenged twice", async () => {
    const { runner, calls } = setup(db, [fixture("challenge")]);
    await runner.whenReady();
    const job = await runner.enqueue({ url: ALBUM_A });
    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS + 1000);
    expect(calls).toHaveLength(2);
    const end = (await jobs.getJob(db, job.id))!;
    expect(end.status).toBe("failed");
    expect(end.error).toMatch(/^\[client_challenge\]/);
  });

  it("honours a persisted cooldown in a new JobRunner, as after an app restart", async () => {
    await setSetting(db, CHALLENGE_SETTING_KEY, { until: T0 + 5 * 60_000, cooldownMs: 5 * 60_000 });
    const left = await jobs.createJob(db, "album", ALBUM_A, [ALBUM_A]);
    await jobs.setJobStatus(db, left.id, "running"); // the app quit mid-job

    const { runner, calls } = setup(db, [fixture("album")]);
    // whenReady() also covers the first pass over the queue, which is now paused: don't wait on it.
    const ready = runner.whenReady();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls).toHaveLength(0);
    expect((await jobs.getJob(db, left.id))!.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(60_000 + 1000);
    await ready;
    expect(calls).toHaveLength(1);
    expect((await jobs.getJob(db, left.id))!.status).toBe("done");
  });

  it("fails interactive fetches fast during the cooldown, but a fresh stream URL still plays", async () => {
    await setSetting(db, CHALLENGE_SETTING_KEY, { until: T0 + CHALLENGE_BACKOFF_MS, cooldownMs: CHALLENGE_BACKOFF_MS });
    await upsertTralbum(db, parseTralbumPage(fixture("album"), T0));
    await db.run("UPDATE tracks SET stream_expires_at = ?", [T0 + 86_400_000]);
    const track = (await db.get<{ id: number; stream_url: string }>("SELECT id, stream_url FROM tracks WHERE streamable = 1 LIMIT 1"))!;

    const { fetch, calls } = scriptedFetch([fixture("album")]);
    const core = createCore({ db, fetch });
    expect(await core.challengeUntil()).toBe(T0 + CHALLENGE_BACKOFF_MS);

    expect((await core.getFreshStreamUrl(track.id)).url).toBe(track.stream_url);
    for (const p of [core.getFreshStreamUrl(track.id, true), core.search("some band"), core.browse("https://someone.bandcamp.com")]) {
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ScrapeError);
      expect(err.code).toBe("challenge_cooldown");
      expect(err.detail.until).toBe(T0 + CHALLENGE_BACKOFF_MS);
      expect(err.message).toContain("12:01");
    }
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(CHALLENGE_BACKOFF_MS);
    expect(await core.challengeUntil()).toBeNull();
  });

  it("starts from the base backoff again after a quiet spell", async () => {
    const gate = new ChallengeGate();
    await gate.trip(T0);
    await gate.trip(T0 + CHALLENGE_BACKOFF_MS);
    expect(gate.until(T0 + CHALLENGE_BACKOFF_MS)).toBe(T0 + 3 * CHALLENGE_BACKOFF_MS);
    const later = T0 + 3 * CHALLENGE_BACKOFF_MS + 60 * 60_000;
    await gate.trip(later);
    expect(gate.until(later)).toBe(later + CHALLENGE_BACKOFF_MS);
  });
});
