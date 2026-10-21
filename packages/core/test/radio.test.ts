import { describe, it, expect, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ScrapeError } from "../src/scrape/errors.js";
import { parseRadioList, parseRadioShow, radioEntryAt, radioImageUrl, radioShowUrl, RADIO_CDN_URL, RADIO_LIST_URL, RADIO_STREAM_URL } from "../src/scrape/radio.js";
import { readJsonAttr } from "../src/scrape/html.js";
import { RadioService, radioQueueTrack, isRadioTrack, isQueueRadio, RADIO_LIST_CACHE_MS } from "../src/services/radio.js";
import { upsertTralbum } from "../src/services/importService.js";
import { markRemoving } from "../src/db/repos/albumRemoval.js";
import { parseTralbumPage } from "../src/scrape/parseTralbum.js";
import { nowPlayingMetadata } from "../src/services/nowPlaying.js";
import { buildMiniState, parseMiniState } from "../src/services/miniPlayer.js";
import { transitionKind, DEFAULT_PLAYBACK } from "../src/services/transition.js";

const SHOW_ID = 1008;

describe("parseRadioList (bandcamp.com/radio)", () => {
  it("reads the latest episodes, newest first, with programme and canonical page", () => {
    const shows = parseRadioList(fixture("radio"));
    expect(shows).toHaveLength(20);
    expect(shows[0]).toEqual({
      id: SHOW_ID,
      title: "Omasta",
      program: "Bandcamp Selects",
      date: "2026-10-19T00:00:00.000Z",
      description: "Polish band Omasta return with their streetwise, contemporary take on jazz.",
      image_id: 47798096,
      url: "https://bandcamp.com/radio/bandcamp-selects/1008",
    });
    // The list's dates run newest first.
    const dates = shows.map((s) => Date.parse(s.date!));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(new Set(shows.map((s) => s.program))).toContain("The Metal Show");
    // Titles are trimmed ("COMPKILLER VOL.1 " on the page).
    expect(shows.every((s) => s.title === s.title.trim())).toBe(true);
  });

  it("rejects the bot check and pages without the blob", () => {
    expect(() => parseRadioList(fixture("challenge"))).toThrow(ScrapeError);
    expect(() => parseRadioList("<html><title>x</title></html>")).toThrow(/no data-blob/);
  });
});

describe("parseRadioShow (an episode page)", () => {
  const show = parseRadioShow(fixture("radio-show"));

  it("has one compiled audio file and the episode's details", () => {
    expect(show).toMatchObject({ id: SHOW_ID, title: "Omasta", program: "Bandcamp Selects", image_id: 47798096, url: "https://bandcamp.com/radio/bandcamp-selects/1008" });
    expect(show.duration).toBeCloseTo(5459.84);
    expect(show.stream_url).toMatch(/^https:\/\/bandcamp\.com\/stream_redirect\?enc=mp3-128&track_id=\d+&ts=\d+&t=[0-9a-f]+$/);
  });

  it("lists the featured tracks by timecode, linking each to its release", () => {
    expect(show.tracks).toHaveLength(18);
    expect(show.tracks.map((t) => t.timecode)).toEqual([...show.tracks.map((t) => t.timecode)].sort((a, b) => a - b));
    expect(show.tracks[0]).toEqual({
      timecode: 0, duration: 412.613, title: "Painted Paradise", artist: "Jiro Inagaki & Soul Media", album_title: "Funky Stuff",
      art_id: 4008340524, url: "https://180g-j-digs.bandcamp.com/album/funky-stuff", album_id: null,
    });
    // A track that is on no album links to the track itself.
    const single = show.tracks.find((t) => t.timecode === 400)!;
    expect(single.album_title).toBeNull();
    expect(single.url).toBe("https://tomokisanders1.bandcamp.com/track/jazz-is-just-a-game-feat-nicholas-payton-m-lanie-charles");
    // Every link is a canonical album/track URL (normalizeBandcampUrl), the shape the importer takes.
    for (const t of show.tracks) expect(t.url).toMatch(/^https:\/\/[a-z0-9-]+\.bandcamp\.com\/(album|track)\/[^/?#]+$/);
  });

  it("drops a stream that isn't Bandcamp's and links that aren't releases", () => {
    const html = fixture("radio-show")
      .replace(/https:\/\/bandcamp\.com\/stream_redirect/, "https://evil.example/stream_redirect")
      .replace("https://180g-j-digs.bandcamp.com/album/funky-stuff", "https://180g-j-digs.bandcamp.com/merch");
    const s = parseRadioShow(html);
    expect(s.stream_url).toBeNull();
    expect(s.tracks[0].url).toBe("https://180g-j-digs.bandcamp.com/track/painted-paradise");
  });
});

/** A fixture with its data-blob JSON edited, re-embedded the way Bandcamp escapes it. */
function withBlob(name: string, edit: (blob: any) => void): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const blob = readJsonAttr<any>(fixture(name), "data-blob"); // eslint-disable-line @typescript-eslint/no-explicit-any
  edit(blob);
  return `<html><head><title>x</title></head><body><div id="pagedata" data-blob="${JSON.stringify(blob).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div></body></html>`;
}

describe("malformed entries are dropped, not fatal", () => {
  it("an episode with a broken tracklist entry keeps its audio and the other entries", () => {
    const html = withBlob("radio-show", (b) => {
      const t = b.appData.show.tracks;
      delete t[1].timecode; // can't be placed on the playhead: dropped
      t[2].title = null; // kept, untitled
      t[3] = "not an entry";
      t[4].timecode = "12:00";
    });
    const s = parseRadioShow(html);
    expect(s.stream_url).toMatch(RADIO_STREAM_URL);
    expect(s.tracks).toHaveLength(15);
    expect(s.tracks.find((t) => t.timecode === 876)?.title).toBe("");
    expect(s.tracks.some((t) => t.timecode === 400)).toBe(false);
  });

  it("an episode without a tracklist or title still plays", () => {
    const s = parseRadioShow(withBlob("radio-show", (b) => { b.appData.show.tracks = null; b.appData.show.title = null; }));
    expect(s.tracks).toEqual([]);
    expect(s.title).toBe("Bandcamp Selects");
    expect(s.stream_url).toMatch(RADIO_STREAM_URL);
  });

  it("only a stream_redirect on bandcamp.com is taken as the stream", () => {
    for (const u of ["https://t4.bcbits.com/stream/x/mp3-128/1?ts=1", "https://bandcamp.com/radio", "http://bandcamp.com/stream_redirect?x=1", "https://bandcamp.com.evil.example/stream_redirect?x=1"]) {
      expect(parseRadioShow(withBlob("radio-show", (b) => { b.appData.show.compiledTrack.streamUrl = u; })).stream_url).toBeNull();
    }
  });

  it("one bad show doesn't blank the list", () => {
    const shows = parseRadioList(withBlob("radio", (b) => {
      const l = b.appData.shows;
      l[0].title = null;
      delete l[1].itemId;
      l[2] = 42;
      l[3].imageId = "big";
    }));
    expect(shows).toHaveLength(17);
    expect(shows[0]).toMatchObject({ title: "Hermanos Gutiérrez", image_id: null });
  });
});

describe("radioEntryAt (now featuring)", () => {
  const tracks = [{ timecode: 0 }, { timecode: 400 }, { timecode: 876 }];
  it("is the last entry whose timecode the playhead reached", () => {
    expect(radioEntryAt(tracks, 0)).toBe(0);
    expect(radioEntryAt(tracks, 399.9)).toBe(0);
    expect(radioEntryAt(tracks, 400)).toBe(1);
    expect(radioEntryAt(tracks, 875)).toBe(1);
    expect(radioEntryAt(tracks, 5000)).toBe(2);
  });
  it("is -1 before the first entry, for no entries or no position", () => {
    expect(radioEntryAt([{ timecode: 30 }], 10)).toBe(-1);
    expect(radioEntryAt([], 10)).toBe(-1);
    expect(radioEntryAt(tracks, NaN)).toBe(-1);
  });
  it("follows the real episode", () => {
    const show = parseRadioShow(fixture("radio-show"));
    expect(show.tracks[radioEntryAt(show.tracks, 1900)].title).toBe("Jane Doe");
    expect(show.tracks[radioEntryAt(show.tracks, show.duration!)].title).toBe("Pirrica");
  });
});

const cdnUrl = () => `https://t4.bcbits.com/stream/db2df1ace37978b61e4c9987ab84f27f/mp3-128/109676427?p=0&ts=${Math.floor(Date.now() / 1000) + 86400}&t=1d57&token=x`;

/**
 * Bandcamp offline: the pages from fixtures, and stream_redirect answering a 302 (only when
 * asked not to follow it). `redirect` replaces the Location; `stale` makes the redirect 404.
 */
function setup(pages: Record<string, () => string>, opts: { redirect?: () => string; stale?: () => boolean } = {}) {
  const db = new NodeDb();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://bandcamp.com/stream_redirect?")) {
      if (init?.redirect !== "manual") throw new Error("the stream redirect must not be followed");
      if (opts.stale?.()) return new Response("", { status: 404 });
      return new Response("<html>moved</html>", { status: 302, headers: { location: (opts.redirect ?? cdnUrl)() } });
    }
    const page = pages[url];
    return page ? new Response(page(), { status: 200 }) : new Response("", { status: 404 });
  });
  const svc = new RadioService(db, new FetchQueue(fetch, 0));
  const urls = () => fetch.mock.calls.map((c) => String(c[0]).replace(/\?.*$/, "?…"));
  return { db, fetch, svc, urls };
}

describe("RadioService", () => {
  const pages = { [RADIO_LIST_URL]: () => fixture("radio"), [radioShowUrl(SHOW_ID)]: () => fixture("radio-show") };

  it("reads the show list once a day through the page cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-19T12:00:00Z") });
    try {
      const { fetch, svc } = setup(pages);
      expect((await svc.list())[0].id).toBe(SHOW_ID);
      vi.setSystemTime(Date.now() + RADIO_LIST_CACHE_MS - 60_000);
      await svc.list();
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 120_000);
      await svc.list();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("shares one page request between the tracklist and the stream, and marks imported releases", async () => {
    const { db, svc, urls } = setup(pages);
    const album = parseTralbumPage(fixture("album"), 0);
    await upsertTralbum(db, { ...album, url: "https://omasta.bandcamp.com/album/hits-different" });
    const [show, stream] = await Promise.all([svc.show(SHOW_ID), svc.streamUrl(SHOW_ID)]);
    expect(urls()).toEqual([radioShowUrl(SHOW_ID).replace(/\?.*$/, "?…"), "https://bandcamp.com/stream_redirect?…"]);
    expect("stream_url" in show).toBe(false);
    expect(stream.url).toMatch(RADIO_CDN_URL);
    const omasta = show.tracks.filter((t) => t.url === "https://omasta.bandcamp.com/album/hits-different");
    expect(omasta.length).toBe(4);
    expect(omasta.every((t) => typeof t.album_id === "number" && t.album_id > 0)).toBe(true);
    expect(show.tracks.filter((t) => t.album_id != null)).toHaveLength(4);
    // The tracklist again: from memory, no request.
    await svc.show(SHOW_ID);
    expect(urls()).toHaveLength(2);
  });

  it("reads an album waiting out its Undo (#93) as not imported", async () => {
    const { db, svc } = setup(pages);
    const album = parseTralbumPage(fixture("album"), 0);
    const id = await upsertTralbum(db, { ...album, url: "https://omasta.bandcamp.com/album/hits-different" });
    expect((await svc.show(SHOW_ID)).tracks.filter((t) => t.album_id === id)).toHaveLength(4);
    await markRemoving(db, id);
    expect((await svc.show(SHOW_ID)).tracks.every((t) => t.album_id === null)).toBe(true);
  });

  it("resolves the redirect to the CDN through the queue, with the CDN URL's own expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-19T12:00:00Z") });
    try {
      const { fetch, svc } = setup(pages);
      const s = await svc.streamUrl(SHOW_ID);
      expect(s.url).toMatch(/^https:\/\/t4\.bcbits\.com\/stream\//);
      expect(s.expires_at).toBe((Math.floor(Date.now() / 1000) + 86400) * 1000);
      // The stream_redirect request carried the queue's plain headers and was not followed.
      const [, init] = fetch.mock.calls[1];
      expect(init).toMatchObject({ redirect: "manual" });
      expect((init!.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
      // Reused for hours: no request until it nears its expiry.
      vi.setSystemTime(Date.now() + 20 * 3600_000);
      expect((await svc.streamUrl(SHOW_ID)).url).toBe(s.url);
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 3.5 * 3600_000);
      await svc.streamUrl(SHOW_ID);
      expect(fetch).toHaveBeenCalledTimes(4); // page (cache expired) + redirect
    } finally { vi.useRealTimers(); }
  });

  it("reads the page again and resolves afresh when forced (a media error)", async () => {
    const { svc, urls } = setup(pages);
    await svc.streamUrl(SHOW_ID);
    await svc.streamUrl(SHOW_ID, true);
    expect(urls()).toEqual(Array(2).fill([radioShowUrl(SHOW_ID).replace(/\?.*$/, "?…"), "https://bandcamp.com/stream_redirect?…"]).flat());
  });

  it("reads the page once more when a cached page's redirect has gone stale", async () => {
    let stale = true;
    const { svc, urls } = setup(pages, { stale: () => { const s = stale; stale = false; return s; } });
    expect((await svc.streamUrl(SHOW_ID)).url).toMatch(RADIO_CDN_URL);
    expect(urls()).toHaveLength(4);
  });

  it("refuses a redirect that leads anywhere but Bandcamp's stream CDN", async () => {
    for (const to of ["https://evil.example/stream/x.mp3", "http://t4.bcbits.com/stream/x", "https://f4.bcbits.com/img/a1_16.jpg", "https://bcbits.com.evil.example/stream/x"]) {
      const { svc } = setup(pages, { redirect: () => to });
      await expect(svc.streamUrl(SHOW_ID)).rejects.toMatchObject({ code: "not_streamable" });
    }
  });

  it("refuses ids that can't be a show without a request", async () => {
    const { fetch, svc } = setup(pages);
    await expect(svc.show(-5)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.streamUrl(0)).rejects.toMatchObject({ code: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the library only about the episode's releases", async () => {
    const { db, svc } = setup(pages);
    const spy = vi.spyOn(db, "select");
    await svc.show(SHOW_ID);
    const [sql, params] = spy.mock.calls.find((c) => /FROM albums/.test(c[0]))!;
    expect(sql).toMatch(/WHERE al\.url IN \(/);
    expect((params as string[]).length).toBe(new Set(parseRadioShow(fixture("radio-show")).tracks.map((t) => t.url)).size);
  });
});

describe("a restored queue entry's radio field", () => {
  it("must have the shape radioQueueTrack gives it", () => {
    expect(isQueueRadio({ show_id: 1008, image_id: 47798096, program: "Bandcamp Selects" })).toBe(true);
    expect(isQueueRadio({ show_id: 1008, image_id: null, program: "" })).toBe(true);
    for (const bad of [null, "radio", { show_id: "1008", image_id: null, program: "x" }, { show_id: -1, image_id: null, program: "x" }, { show_id: 1, image_id: 1.5, program: "x" }, { show_id: 1, image_id: null }]) {
      expect(isQueueRadio(bad)).toBe(false);
    }
  });
});

describe("a radio episode in the queue", () => {
  const summary = parseRadioList(fixture("radio"))[0];
  const q = radioQueueTrack({ ...summary, duration: 5459.84 });

  it("is one long track that can't be mistaken for a library track", () => {
    expect(q).toMatchObject({ id: -SHOW_ID, album_id: -SHOW_ID, title: "Omasta", artist_name: "Bandcamp Selects", streamable: true, art_id: null, duration: 5459.84 });
    expect(q.radio).toEqual({ show_id: SHOW_ID, image_id: 47798096, program: "Bandcamp Selects" });
    expect(isRadioTrack(q)).toBe(true);
    expect(isRadioTrack({ id: 3 })).toBe(false);
  });

  it("crossfades like any other album change, and two episodes are two albums", () => {
    const next = { album_id: 7, duration: 200 };
    const s = { ...DEFAULT_PLAYBACK, crossfadeSec: 6 };
    expect(transitionKind(q, next, s, 5459)).toBe("crossfade");
    expect(transitionKind(q, radioQueueTrack({ ...summary, id: 991 }), s, 5459)).toBe("crossfade");
  });

  it("shows the episode in Now Playing, with the featured track as the artist line", () => {
    const m = nowPlayingMetadata(q, { title: "Jane Doe", artist: "Omasta" });
    expect(m).toMatchObject({ title: "Omasta", artist: "Omasta – Jane Doe", album: "Bandcamp Selects" });
    expect(m.artwork[0].src).toBe(radioImageUrl(47798096, 16));
    expect(m.artwork[0].src).toBe("https://f4.bcbits.com/img/0047798096_16.jpg");
    expect(nowPlayingMetadata(q).artist).toBe("Bandcamp Selects");
  });

  it("carries its image to the mini player", () => {
    const st = buildMiniState({ queue: [q], index: 0, status: "playing", position: 0, duration: 5459 }, null, null);
    expect(st.track).toMatchObject({ id: -SHOW_ID, title: "Omasta", artId: null, imageId: 47798096 });
    expect(parseMiniState(JSON.parse(JSON.stringify(st)))?.track?.imageId).toBe(47798096);
  });
});
