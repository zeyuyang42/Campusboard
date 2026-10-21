import { describe, it, expect } from "vitest";
import {
  buildMiniState, extrapolatePosition, miniLiveAfter, miniStateKey, MiniStateThrottle, parseMiniCommand, parseMiniState, type MiniState,
} from "../src/services/miniPlayer.js";
import { DEFAULT_THEME } from "../src/theme/index.js";

const track = { id: 7, title: "Pool Hopping", artist_name: "illuminati hotties", track_artist: null, album_title: "Let Me Do One More", art_id: 1234567 };
const palette = { accent: "#5bb6d1", accentText: "#000000", ambient1: "#334455", ambient2: "#223344" };
const base = (over: Partial<MiniState> = {}): MiniState => ({
  ...buildMiniState({ queue: [track], index: 0, status: "playing", position: 10, duration: 200 }, palette, DEFAULT_THEME),
  ...over,
});

describe("parseMiniCommand", () => {
  it("accepts the known commands and drops extra fields", () => {
    for (const type of ["hello", "bye", "toggle", "play", "pause", "next", "prev", "showMain"]) {
      expect(parseMiniCommand({ type, extra: "x" })).toEqual({ type });
    }
    expect(parseMiniCommand({ type: "seek", sec: 12.5 })).toEqual({ type: "seek", sec: 12.5 });
  });

  it("rejects unknown types, non-objects and bad seeks", () => {
    for (const bad of [null, undefined, 3, "toggle", [], {}, { type: "eval" }, { type: "setVolume", v: 1 }, { type: "__proto__" },
      { type: "seek" }, { type: "seek", sec: -1 }, { type: "seek", sec: Number.NaN }, { type: "seek", sec: Infinity }, { type: "seek", sec: "5" }]) {
      expect(parseMiniCommand(bad)).toBeNull();
    }
  });

  it("caps a seek at 24 hours", () => {
    expect(parseMiniCommand({ type: "seek", sec: 1e12 })).toEqual({ type: "seek", sec: 86400 });
  });
});

describe("parseMiniState", () => {
  it("round-trips a built state", () => {
    const s = base();
    expect(parseMiniState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects malformed states", () => {
    for (const bad of [null, "x", {}, { status: "exploding" }, { status: "playing", track: { id: "1", title: "a", artist: "b", album: "c" } },
      { status: "playing", track: { id: 1.5, title: "a", artist: "b", album: "c" } }]) {
      expect(parseMiniState(bad)).toBeNull();
    }
  });

  it("drops a palette with anything but hex colors", () => {
    const evil = { ...palette, accent: "red; background: url(https://x)" };
    expect(parseMiniState({ ...base(), palette: evil })?.palette).toBeNull();
    expect(parseMiniState({ ...base(), palette: { ...palette, ambient2: "#12345" } })?.palette).toBeNull();
  });

  it("keeps hex swatches (#110), drops bad ones and caps them at six, and never fails the palette over them", () => {
    const good = ["#112233", "#445566"];
    expect(parseMiniState({ ...base(), palette: { ...palette, swatches: good } })?.palette?.swatches).toEqual(good);
    const mixed = ["#112233", "url(x)", 7, null, "#44556", "#AABBCCDD"];
    expect(parseMiniState({ ...base(), palette: { ...palette, swatches: mixed } })?.palette?.swatches).toEqual(["#112233", "#AABBCCDD"]);
    expect(parseMiniState({ ...base(), palette: { ...palette, swatches: "nope" } })?.palette).toEqual(palette);
    expect(parseMiniState({ ...base(), palette: { ...palette, swatches: ["bad"] } })?.palette).toEqual(palette);
    const many = Array.from({ length: 9 }, (_, i) => `#00000${i}`);
    expect(parseMiniState({ ...base(), palette: { ...palette, swatches: many } })?.palette?.swatches).toHaveLength(6);
  });

  it("sanitises numbers and text", () => {
    const s = parseMiniState({ ...base(), position: 999, duration: 200, track: { ...base().track, title: "t".repeat(1000), artId: -3 } })!;
    expect(s.position).toBe(200);
    expect(s.track!.title.length).toBe(300);
    expect(s.track!.artId).toBeNull();
    expect(parseMiniState({ ...base(), position: Number.NaN, duration: -1 })).toMatchObject({ position: 0, duration: 0 });
  });
});

describe("buildMiniState", () => {
  it("maps the current queue entry, preferring the track artist", () => {
    const s = buildMiniState({ queue: [track, { ...track, id: 8, track_artist: "Guest" }], index: 1, status: "paused", position: 3, duration: 100 }, null, null);
    expect(s.track).toEqual({ id: 8, title: "Pool Hopping", artist: "Guest", album: "Let Me Do One More", artId: 1234567 });
    expect(s.status).toBe("paused");
  });

  it("is idle with an empty queue and clamps odd numbers", () => {
    expect(buildMiniState({ queue: [], index: 0, status: "paused", position: 4, duration: 0 }, null, null)).toMatchObject({ track: null, status: "idle" });
    expect(buildMiniState({ queue: [track], index: 0, status: "loading", position: 50, duration: Number.NaN }, null, null)).toMatchObject({ duration: 0, position: 50 });
    expect(buildMiniState({ queue: [track], index: 0, status: "playing", position: 300, duration: 200 }, null, null).position).toBe(200);
  });
});

describe("MiniStateThrottle", () => {
  it("sends the first state and every non-position change at once", () => {
    const t = new MiniStateThrottle();
    expect(t.next(base(), 0)).toBe(true);
    expect(t.next(base({ position: 10.25 }), 250)).toBe(false);
    expect(t.next(base({ status: "paused", position: 10.3 }), 300)).toBe(true);
    expect(t.next(base({ status: "paused", position: 10.3, palette: null }), 310)).toBe(true);
    expect(miniStateKey(base())).not.toBe(miniStateKey(base({ track: null })));
  });

  it("ticks the position once a second while playing", () => {
    const t = new MiniStateThrottle(1000);
    t.next(base({ position: 0 }), 0);
    const sent = [];
    for (let ms = 250; ms <= 3000; ms += 250) if (t.next(base({ position: ms / 1000 }), ms)) sent.push(ms);
    expect(sent).toEqual([1000, 2000, 3000]);
  });

  it("sends a seek while playing at once, and any position change while paused", () => {
    const t = new MiniStateThrottle(1000);
    t.next(base({ position: 10 }), 0);
    expect(t.next(base({ position: 60 }), 200)).toBe(true);
    const p = new MiniStateThrottle(1000);
    p.next(base({ status: "paused", position: 10 }), 0);
    expect(p.next(base({ status: "paused", position: 10 }), 5000)).toBe(false);
    expect(p.next(base({ status: "paused", position: 10.5 }), 5100)).toBe(true);
  });

  it("sends again after reset", () => {
    const t = new MiniStateThrottle();
    t.next(base(), 0);
    expect(t.next(base(), 10)).toBe(false);
    t.reset();
    expect(t.next(base(), 20)).toBe(true);
  });
});

describe("miniLiveAfter", () => {
  it("starts on hello, stops on bye, and is left alone by everything else", () => {
    expect(parseMiniCommand({ type: "bye" })).toEqual({ type: "bye" });
    expect(miniLiveAfter(false, { type: "hello" })).toBe(true);
    expect(miniLiveAfter(true, { type: "bye" })).toBe(false);
    for (const cmd of [{ type: "toggle" }, { type: "seek", sec: 3 }, { type: "showMain" }] as const) {
      expect(miniLiveAfter(true, cmd)).toBe(true);
      expect(miniLiveAfter(false, cmd)).toBe(false);
    }
  });

  it("open, hide, reopen: sends only while open", () => {
    let live = false;
    const sent: boolean[] = [];
    for (const type of ["hello", "toggle", "bye", "next", "hello"] as const) {
      live = miniLiveAfter(live, { type });
      sent.push(live);
    }
    expect(sent).toEqual([true, true, false, false, true]);
  });
});

describe("extrapolatePosition", () => {
  it("advances only while playing and stops at the duration", () => {
    expect(extrapolatePosition({ status: "playing", position: 10, duration: 200 }, 1500)).toBe(11.5);
    expect(extrapolatePosition({ status: "paused", position: 10, duration: 200 }, 1500)).toBe(10);
    expect(extrapolatePosition({ status: "playing", position: 199.5, duration: 200 }, 5000)).toBe(200);
    expect(extrapolatePosition({ status: "playing", position: 5, duration: 0 }, 1000)).toBe(6);
  });
});
