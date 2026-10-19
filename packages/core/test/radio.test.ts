import { describe, it, expect, vi } from "vitest";
import { NodeDb } from "./helpers/nodeDb.js";
import { fixture } from "./helpers.js";
import { FetchQueue } from "../src/scrape/http.js";
import { ScrapeError } from "../src/scrape/errors.js";
import { parseRadioList, parseRadioShow, radioEntryAt, radioImageUrl, radioShowUrl, RADIO_LIST_URL } from "../src/scrape/radio.js";
import { RadioService, radioQueueTrack, radioStreamExpiry, isRadioTrack, RADIO_LIST_CACHE_MS, RADIO_STREAM_TTL_MS } from "../src/services/radio.js";
import { upsertTralbum } from "../src/services/importService.js";
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

function setup(pages: Record<string, () => string>) {
  const db = new NodeDb();
  const fetch = vi.fn(async (url: string) => {
    const page = pages[url];
    return page ? new Response(page(), { status: 200 }) : new Response("", { status: 404 });
  });
  const svc = new RadioService(db, new FetchQueue(fetch, 0));
  return { db, fetch, svc };
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

  it("shares one request between the tracklist and the stream URL, and marks imported releases", async () => {
    const { db, fetch, svc } = setup(pages);
    const album = parseTralbumPage(fixture("album"), 0);
    await upsertTralbum(db, { ...album, url: "https://omasta.bandcamp.com/album/hits-different" });
    const [show, stream] = await Promise.all([svc.show(SHOW_ID), svc.streamUrl(SHOW_ID)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(radioShowUrl(SHOW_ID));
    expect(stream.url).toContain("stream_redirect");
    expect("stream_url" in show).toBe(false);
    const omasta = show.tracks.filter((t) => t.url === "https://omasta.bandcamp.com/album/hits-different");
    expect(omasta.length).toBe(4);
    expect(omasta.every((t) => typeof t.album_id === "number" && t.album_id > 0)).toBe(true);
    expect(show.tracks.filter((t) => t.album_id != null)).toHaveLength(4);
    // The tracklist again: from memory, no request.
    await svc.show(SHOW_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent page for the stream URL, and reads it again when forced (a media error)", async () => {
    const { fetch, svc } = setup(pages);
    await svc.streamUrl(SHOW_ID);
    await svc.streamUrl(SHOW_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
    await svc.streamUrl(SHOW_ID, true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses ids that can't be a show without a request", async () => {
    const { fetch, svc } = setup(pages);
    await expect(svc.show(-5)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.streamUrl(0)).rejects.toMatchObject({ code: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("radio stream expiry", () => {
  it("counts from the URL's issue time", () => {
    expect(radioStreamExpiry("https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=1&ts=1792443737&t=ab", 0)).toBe(1792443737_000 + RADIO_STREAM_TTL_MS);
    expect(radioStreamExpiry("https://bandcamp.com/stream_redirect?x=1", 5)).toBe(5 + RADIO_STREAM_TTL_MS);
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
