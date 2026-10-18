import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ChallengeGate } from "../src/scrape/challenge.js";
import { ReleaseChecker } from "../src/services/releaseWatch.js";
import { upsertTralbum, vacuumOrphans } from "../src/services/importService.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { deleteAlbum } from "../src/db/repos/albums.js";
import { setSetting } from "../src/db/repos/settings.js";
import * as releases from "../src/db/repos/releases.js";
import { createCore } from "../src/core.js";
import { JobRunner } from "../src/services/jobRunner.js";
import * as jobs from "../src/db/repos/jobs.js";
import {
  RELEASE_CHECK_INTERVAL_MS, RELEASE_CHECK_SETTING_KEY, RELEASE_CHECK_START_DELAY_MS, RELEASE_CHECK_TICK_MS,
} from "../src/config.js";

const ORIGIN = "https://illuminatihotties.bandcamp.com";
const MUSIC = `${ORIGIN}/music`;
const NEW_URL = `${ORIGIN}/album/brand-new-thing`;
const HOUR = 60 * 60 * 1000;

/** Grid entry in the shape the real /music page uses. */
const gridItem = (href: string, title: string, artId = 1234567) =>
  `<li data-item-id="album-1" class="music-grid-item square"><a href="${href}"><div class="art"><img src="https://f4.bcbits.com/img/a${artId}_2.jpg" alt="" /></div><p class="title">${title}</p></a></li>`;

/** The saved /music fixture with extra grid entries at the top (newest first, like Bandcamp). */
function musicWith(...items: string[]): string {
  const html = fixture("music");
  const at = html.indexOf('<li data-item-id="album-1758210532"');
  if (at < 0) throw new Error("fixture changed");
  return html.slice(0, at) + items.join("") + html.slice(at);
}

/** A fetch whose body per URL can change between checks; records every request. */
function pages(initial: Record<string, string>) {
  const bodies = { ...initial };
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const body = bodies[url];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetch, calls, bodies };
}

const T0 = new Date("2026-10-17T12:00:00Z").getTime();
let db: NodeDb;
let gate: ChallengeGate;

function setup(initial: Record<string, string> = { [MUSIC]: fixture("music") }, gapMs = 0) {
  const p = pages(initial);
  gate = new ChallengeGate();
  const queue = new FetchQueue(p.fetch, gapMs, gate);
  const checker = new ReleaseChecker(db, queue);
  return { ...p, queue, checker };
}

const statuses = () => db.raw.prepare("SELECT status, COUNT(*) AS n FROM artist_releases GROUP BY status ORDER BY status").all() as { status: string; n: number }[];
const artistId = () => (db.raw.prepare("SELECT id FROM artists").get() as { id: number }).id;

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  db = new NodeDb();
  await upsertTralbum(db, parseTralbumPage(fixture("album"), 0));
});
afterEach(() => { vi.useRealTimers(); });

describe("new releases checker", () => {
  it("records the first check as a baseline: everything on the page is seen, nothing is new", async () => {
    const { checker, calls } = setup();
    const r = await checker.tick();
    expect(r).toMatchObject({ status: "baseline", releases: 20, found: 0 });
    expect(calls).toEqual([MUSIC]);
    expect(statuses()).toEqual([{ status: "seen", n: 20 }]);
    expect(await releases.countNewReleases(db)).toBe(0);
    expect(await releases.getWatch(db, artistId())).toMatchObject({ baselined: 1, last_checked_at: T0, last_error: null });
  });

  it("lists a release that appears on a later check, with art, title and artist", async () => {
    const { checker, bodies, calls } = setup();
    await checker.tick();
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing", 987654321));
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS + 1);
    const r = await checker.tick();
    expect(r).toMatchObject({ status: "checked", releases: 21, found: 1 });
    expect(calls).toHaveLength(2);
    const list = await releases.listNewReleases(db);
    expect(list).toEqual([expect.objectContaining({ url: NEW_URL, title: "Brand New Thing", art_id: 987654321, artist_name: "illuminati hotties", item_type: "album" })]);
    expect(await releases.countNewReleases(db)).toBe(1);
  });

  it("checks each artist at most once per 24 hours", async () => {
    const { checker, calls } = setup();
    await checker.tick();
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS - 1);
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
    expect(calls).toHaveLength(1);
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ status: "checked" });
    expect(calls).toHaveLength(2);
  });

  it("dismissing hides a release for good, and an imported one stops being new", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing"), gridItem("/album/let-me-do-one-more", "Already here"));
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    // let-me-do-one-more was in the baseline already; the fresh one is the only new row.
    await checker.tick();
    const [item] = await releases.listNewReleases(db);
    expect(await releases.dismissReleases(db, [item.id])).toBe(1);
    expect(await releases.countNewReleases(db)).toBe(0);
    vi.setSystemTime(T0 + 2 * RELEASE_CHECK_INTERVAL_MS);
    await checker.tick();
    expect(await releases.countNewReleases(db)).toBe(0);
    expect(statuses()).toEqual([{ status: "dismissed", n: 1 }, { status: "seen", n: 20 }]);
  });

  it("drops a new release from the list once it is in the library", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    // Pretend let-me-do-one-more arrived after the baseline: drop its row and the album, then re-check.
    db.raw.prepare("DELETE FROM artist_releases WHERE url = ?").run(`${ORIGIN}/album/let-me-do-one-more`);
    bodies[MUSIC] = fixture("music");
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    const r = await checker.tick();
    // It's in the library, so it is stored as seen rather than new.
    expect(r).toMatchObject({ found: 0 });
    expect(await releases.countNewReleases(db)).toBe(0);
  });

  it("hides releases that are synced purchases the user removed from the library", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    await checker.tick();
    expect(await releases.countNewReleases(db)).toBe(1);
    db.raw.prepare("INSERT INTO fan_items (list, item_type, bandcamp_id, url, fetch_url, sync_job) VALUES ('collection', 'album', 42, ?, ?, 1)").run(NEW_URL, NEW_URL);
    db.raw.prepare("INSERT INTO fan_dismissed (item_type, bandcamp_id) VALUES ('album', 42)").run();
    expect(await releases.countNewReleases(db)).toBe(0);
  });

  it("skips muted artists and hides what was found for them", async () => {
    const { checker, calls, bodies } = setup();
    await checker.tick();
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    await checker.tick();
    expect(await releases.countNewReleases(db)).toBe(1);
    await releases.setMuted(db, artistId(), true);
    expect(await releases.isMuted(db, artistId())).toBe(true);
    expect(await releases.countNewReleases(db)).toBe(0);
    vi.setSystemTime(T0 + 3 * RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
    expect(await checker.checkNow()).toEqual({ checked: 0, found: 0, stopped: null });
    expect(calls).toHaveLength(2);
    await releases.setMuted(db, artistId(), false);
    expect(await releases.countNewReleases(db)).toBe(1);
  });

  it("muting an artist before its first check still works", async () => {
    const { checker, calls } = setup();
    await releases.setMuted(db, artistId(), true);
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
    expect(calls).toHaveLength(0);
  });

  it("does nothing while a job is queued or running, during a cooldown, or when turned off", async () => {
    const { checker, calls } = setup();
    db.raw.prepare("INSERT INTO jobs (kind, input_url, status) VALUES ('album', 'x', 'running')").run();
    expect(await checker.tick()).toEqual({ skipped: "job" });
    expect(await checker.checkNow()).toMatchObject({ checked: 0, stopped: "job" });
    db.raw.prepare("UPDATE jobs SET status = 'queued'").run();
    expect(await checker.tick()).toEqual({ skipped: "job" });
    db.raw.prepare("UPDATE jobs SET status = 'done'").run();

    await gate.trip();
    expect(await checker.tick()).toEqual({ skipped: "cooldown" });
    vi.setSystemTime(Date.now() + 2 * HOUR);

    await setSetting(db, RELEASE_CHECK_SETTING_KEY, { enabled: false });
    expect(await checker.tick()).toEqual({ skipped: "off" });
    expect(await checker.checkNow()).toMatchObject({ checked: 0, stopped: "off" });
    expect(calls).toHaveLength(0);

    await checker.setEnabled(true);
    expect(await checker.tick()).toMatchObject({ status: "baseline" });
    expect(calls).toHaveLength(1);
  });

  it("a challenge on the check leaves the artist due and makes later ticks wait", async () => {
    const { checker, bodies, calls } = setup();
    bodies[MUSIC] = fixture("challenge");
    const r = await checker.tick();
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { error: string }).error).toMatch(/client_challenge/);
    expect(await releases.getWatch(db, artistId())).toBeNull();
    expect(await checker.tick()).toEqual({ skipped: "cooldown" });
    expect(calls).toHaveLength(1);
  });

  it("a failed check counts as the day's check but doesn't complete the baseline", async () => {
    const { checker, bodies, calls } = setup();
    delete bodies[MUSIC];
    expect(await checker.tick()).toMatchObject({ status: "failed" });
    expect(await releases.getWatch(db, artistId())).toMatchObject({ baselined: 0, last_checked_at: T0 });
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
    expect(calls).toHaveLength(1); // retries = 0: one request, even for an error
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ status: "baseline", found: 0 });
  });

  it("normalises every link and drops ones that fail (LAN hosts, odd paths)", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    bodies[MUSIC] = musicWith(
      gridItem("https://192.168.1.1/album/evil", "LAN"),
      gridItem("https://nas.lan/album/evil", "LAN name"),
      gridItem("https://router/track/evil", "Bare host"),
      gridItem("https://user:pw@evil.example.com/album/x", "Credentials"),
      gridItem("https://evil.example.com:8443/album/x", "Port"),
      gridItem("/album/fine-one?from=x#y", "Fine"),
      gridItem("https://Other-Artist.bandcamp.com/album/split/", "Split"),
    );
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    await checker.tick();
    const urls = (await releases.listNewReleases(db)).map((r) => r.url).sort();
    expect(urls).toEqual([`${ORIGIN}/album/fine-one`, "https://other-artist.bandcamp.com/album/split"]);
    const all = (db.raw.prepare("SELECT url FROM artist_releases").all() as { url: string }[]).map((r) => r.url);
    expect(all.some((u) => /192\.168|nas\.lan|router|evil/.test(u))).toBe(false);
  });

  it("stops checking an artist once their last album is removed", async () => {
    const { checker, calls } = setup();
    await checker.tick();
    const albumId = (db.raw.prepare("SELECT id FROM albums").get() as { id: number }).id;
    await deleteAlbum(db, albumId);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM artist_releases").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM release_watch").get()).toEqual({ n: 0 });
    vi.setSystemTime(T0 + 2 * RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
    expect(calls).toHaveLength(1);
  });

  it("an artist adding, changing or dropping a custom domain doesn't re-list the back catalogue", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    // Same page, now served under a custom domain: data-tralbum names the new origin, links stay relative.
    const custom = (host: string, ...extra: string[]) => musicWith(...extra).replace(
      /data-tralbum="\{&quot;url&quot;:&quot;https:\/\/illuminatihotties\.bandcamp\.com\/music&quot;\}"/,
      `data-tralbum="{&quot;url&quot;:&quot;https://${host}/music&quot;}"`,
    );
    bodies[MUSIC] = custom("music.illuminatihotties.com");
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ status: "checked", releases: 20, found: 0, inserted_ids: [] });
    expect(await releases.countNewReleases(db)).toBe(0);
    // A genuinely new release on the new domain is still found.
    bodies[MUSIC] = custom("music.illuminatihotties.com", gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + 2 * RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ found: 1 });
    expect((await releases.listNewReleases(db)).map((r) => r.url)).toEqual(["https://music.illuminatihotties.com/album/brand-new-thing"]);
    // Changed again, then dropped: still nothing new beyond that one.
    bodies[MUSIC] = custom("another-domain.example.org", gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + 3 * RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ found: 0 });
    bodies[MUSIC] = musicWith(gridItem("/album/brand-new-thing", "Brand New Thing"));
    vi.setSystemTime(T0 + 4 * RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ found: 0 });
    expect(await releases.countNewReleases(db)).toBe(1);
  });

  it("matches the library by path too: an album stored under another host isn't new", async () => {
    const { checker, bodies } = setup();
    await checker.tick();
    // The album was stored under a custom domain; the page lists it under bandcamp.com.
    db.raw.prepare("UPDATE albums SET url = 'https://music.example.org/album/let-me-do-one-more'").run();
    db.raw.prepare("DELETE FROM artist_releases WHERE url = ?").run(`${ORIGIN}/album/let-me-do-one-more`);
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    expect(await checker.tick()).toMatchObject({ found: 0 });
    // And a 'new' row for it is hidden and settled by the same rule.
    db.raw.prepare("UPDATE artist_releases SET status = 'new' WHERE url = ?").run(`${ORIGIN}/album/let-me-do-one-more`);
    expect(await releases.countNewReleases(db)).toBe(0);
    await releases.settleImported(db);
    expect(db.raw.prepare("SELECT status FROM artist_releases WHERE url = ?").get(`${ORIGIN}/album/let-me-do-one-more`)).toEqual({ status: "seen" });
  });

  it("a successful import job settles the release on the core side, even a single already in an album", async () => {
    const { checker, bodies, queue } = setup();
    await checker.tick();
    const POOL = `${ORIGIN}/track/pool-hopping`;
    bodies[MUSIC] = musicWith(gridItem("/track/pool-hopping", "Pool Hopping"), gridItem("/album/brand-new-thing", "Brand New Thing"));
    bodies[POOL] = fixture("track");
    vi.setSystemTime(T0 + RELEASE_CHECK_INTERVAL_MS);
    await checker.tick();
    expect(await releases.countNewReleases(db)).toBe(2);
    const runner = new JobRunner(db, queue);
    await runner.whenReady();
    const job = await runner.enqueue({ url: POOL });
    await vi.advanceTimersByTimeAsync(100);
    expect((await jobs.getJob(db, job.id))!.status).toBe("done");
    // Its track lives in let-me-do-one-more, so its own URL never enters albums: settled by the job.
    expect(db.raw.prepare("SELECT status FROM artist_releases WHERE url = ?").get(POOL)).toEqual({ status: "seen" });
    expect((await releases.listNewReleases(db)).map((r) => r.title)).toEqual(["Brand New Thing"]);
  });

  it("a tick and Check now never overlap: the busy flag is taken before any await", async () => {
    const { checker, calls } = setup({ [MUSIC]: fixture("music") }, 1000);
    const a = checker.tick();
    const b = checker.checkNow();
    const c = checker.tick();
    const d = checker.checkArtist(artistId());
    expect(await b).toEqual({ checked: 0, found: 0, stopped: "busy" });
    expect(await c).toEqual({ skipped: "busy" });
    expect(await d).toMatchObject({ status: "skipped", error: "busy" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await a).toMatchObject({ status: "baseline" });
    expect(calls).toHaveLength(1);
    // And free again afterwards.
    expect(await checker.tick()).toEqual({ skipped: "none_due" });
  });

  it("vacuumOrphans sweeps rows of artists deleted with foreign keys off", async () => {
    const { checker } = setup();
    await checker.tick();
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.raw.prepare("DELETE FROM albums").run();
    db.raw.prepare("DELETE FROM artists").run();
    db.raw.exec("PRAGMA foreign_keys = ON");
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM artist_releases").get()).toEqual({ n: 20 });
    await vacuumOrphans(db);
    expect(db.raw.prepare("SELECT (SELECT COUNT(*) FROM artist_releases) + (SELECT COUNT(*) FROM release_watch) AS n").get()).toEqual({ n: 0 });
  });

  it("is polite: no request at launch, never more than one per tick, one per artist per day", async () => {
    // Three more artists, each with one album.
    const hosts = ["a-one", "b-two", "c-three"].map((h) => `https://${h}.bandcamp.com`);
    const initial: Record<string, string> = { [MUSIC]: fixture("music") };
    hosts.forEach((h, i) => {
      const r = db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (?, ?, ?) RETURNING id").get(100 + i, h, h) as { id: number };
      db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (?, 'album', ?, 't', ?, 'x')").run(200 + i, r.id, `${h}/album/t`);
      initial[`${h}/music`] = `<html><div data-band="{&quot;id&quot;:${100 + i},&quot;name&quot;:&quot;x&quot;}"></div><ol id="music-grid">${gridItem("/album/t", "T")}</ol></html>`;
    });
    const { checker, calls } = setup(initial, 1000);
    checker.start();
    checker.start(); // idempotent
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_START_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    const perTick: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(i === 0 ? 1 : RELEASE_CHECK_TICK_MS);
      perTick.push(calls.length - before);
    }
    expect(Math.max(...perTick)).toBe(1);
    expect(perTick.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(new Set(calls).size).toBe(4);
    // A full day later: each of the four artists exactly once more.
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_INTERVAL_MS);
    expect(calls).toHaveLength(8);
    checker.stop();
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_INTERVAL_MS);
    expect(calls).toHaveLength(8);
  });

  it("Check now goes through every artist, one request each at the queue's 1 req/s", async () => {
    const other = "https://zz-other.bandcamp.com";
    const r = db.raw.prepare("INSERT INTO artists (band_id, name, url) VALUES (7, 'Other', ?) RETURNING id").get(other) as { id: number };
    db.raw.prepare("INSERT INTO albums (bandcamp_id, item_type, artist_id, title, url, fetched_at) VALUES (7, 'album', ?, 't', ?, 'x')").run(r.id, `${other}/album/t`);
    const { checker, calls } = setup({ [MUSIC]: fixture("music"), [`${other}/music`]: `<html><div data-band="{&quot;id&quot;:7,&quot;name&quot;:&quot;Other&quot;}"></div><ol id="music-grid">${gridItem("/album/t", "T")}</ol></html>` }, 1000);
    const done = checker.checkNow();
    expect((await checker.status()).running).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toEqual({ checked: 2, found: 0, stopped: null });
    expect(calls).toHaveLength(2);
    const st = await checker.status();
    expect(st).toMatchObject({ enabled: true, artists: 2, muted: 0, running: false });
    expect(st.last_check_at).toBeGreaterThanOrEqual(T0);
  });

  it("is wired through createCore and not started by it", async () => {
    const p = pages({ [MUSIC]: fixture("music") });
    const changes: number[] = [];
    const core = createCore({ db, fetch: p.fetch, onReleasesChange: () => changes.push(1) });
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_START_DELAY_MS + 10 * RELEASE_CHECK_TICK_MS);
    expect(p.calls).toHaveLength(0);
    const r = core.checkArtistReleases(artistId());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await r).toMatchObject({ status: "baseline", found: 0 });
    expect((await r).inserted_ids).toHaveLength(20);
    expect(changes.length).toBeGreaterThan(0);
    expect(await core.newReleaseCount()).toBe(0);
    await core.setArtistReleasesMuted(artistId(), true);
    expect(await core.artistReleasesMuted(artistId())).toBe(true);
    expect((await core.releaseCheckStatus()).muted).toBe(1);
  });
});
