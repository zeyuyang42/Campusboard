import { describe, it, expect } from "vitest";
import {
  crossfadeGains, DEFAULT_PLAYBACK, elementRole, fadeProgress, fadeSeconds, gaplessDelayMs, IDLE, parsePlaybackSettings, preloadDue,
  preloadStale, PRELOAD_EXPIRY_MARGIN_MS, PRELOAD_LEAD_SEC, routeElementEvent, standbyUsable, transitionAfter, transitionKind,
  transitionPoint, upcomingIndex, CROSSFADE_MAX_SEC, type TransitionState,
} from "../src/services/transition.js";
import { audioEventPatch } from "../src/services/audioEvents.js";
import { positionToGain } from "../src/services/volume.js";

const fade = (crossfadeSec: number, gapless = true) => ({ gapless, crossfadeSec });

describe("playback settings (#35)", () => {
  it("defaults to gapless on, crossfade off", () => {
    expect(DEFAULT_PLAYBACK).toEqual({ gapless: true, crossfadeSec: 0 });
    expect(parsePlaybackSettings(null)).toEqual(DEFAULT_PLAYBACK);
    expect(parsePlaybackSettings("junk")).toEqual(DEFAULT_PLAYBACK);
  });
  it("clamps the crossfade to 0-10 s and keeps valid values", () => {
    expect(parsePlaybackSettings({ gapless: false, crossfadeSec: 4 })).toEqual({ gapless: false, crossfadeSec: 4 });
    expect(parsePlaybackSettings({ crossfadeSec: 99 }).crossfadeSec).toBe(CROSSFADE_MAX_SEC);
    expect(parsePlaybackSettings({ crossfadeSec: -3 }).crossfadeSec).toBe(0);
    expect(parsePlaybackSettings({ crossfadeSec: Number.NaN }).crossfadeSec).toBe(0);
    expect(parsePlaybackSettings({ gapless: "yes" }).gapless).toBe(true);
  });
});

describe("which track comes next", () => {
  it("follows next(auto): the following index, wrapping only with repeat all", () => {
    expect(upcomingIndex(3, 0, "off")).toBe(1);
    expect(upcomingIndex(3, 2, "off")).toBeNull();
    expect(upcomingIndex(3, 2, "all")).toBe(0);
    expect(upcomingIndex(1, 0, "all")).toBe(0);
  });
  it("repeat one restarts the same playback, so there is no transition", () => {
    expect(upcomingIndex(3, 0, "one")).toBeNull();
  });
  it("an empty queue or a bad index has none", () => {
    expect(upcomingIndex(0, 0, "all")).toBeNull();
    expect(upcomingIndex(2, 5, "off")).toBeNull();
  });
});

describe("the kind of transition", () => {
  const a1 = { album_id: 1, duration: 200 }, a1b = { album_id: 1, duration: 180 }, b = { album_id: 2, duration: 240 };
  it("never crossfades within an album: album transitions stay intact", () => {
    expect(transitionKind(a1, a1b, fade(6))).toBe("gapless");
    expect(transitionKind(a1, a1b, fade(6, false))).toBe("plain");
  });
  it("crossfades between albums when a fade is set", () => {
    expect(transitionKind(a1, b, fade(6))).toBe("crossfade");
    expect(transitionKind(a1, b, fade(6, false))).toBe("crossfade");
  });
  it("crossfade off: gapless when on, else the plain load on ended", () => {
    expect(transitionKind(a1, b, fade(0))).toBe("gapless");
    expect(transitionKind(a1, b, fade(0, false))).toBe("plain");
  });
  it("a fade too short after clamping to the tracks is a gapless switch", () => {
    expect(transitionKind({ album_id: 1, duration: 0.6 }, b, fade(6))).toBe("gapless");
  });
  it("clamps the fade to half of either track", () => {
    expect(fadeSeconds(fade(10), 12, 300)).toBe(6);
    expect(fadeSeconds(fade(10), 300, 8)).toBe(4);
    expect(fadeSeconds(fade(10), null, undefined)).toBe(10);
    expect(fadeSeconds(fade(0), 300, 300)).toBe(0);
  });
});

describe("when to preload and start", () => {
  it("the transition point is the end, or the fade length before it", () => {
    expect(transitionPoint("gapless", 200, 0)).toBe(200);
    expect(transitionPoint("crossfade", 200, 6)).toBe(194);
    expect(transitionPoint("crossfade", 4, 6)).toBe(0);
  });
  it("preloads PRELOAD_LEAD_SEC before the point", () => {
    expect(preloadDue(200 - PRELOAD_LEAD_SEC - 1, 200)).toBe(false);
    expect(preloadDue(200 - PRELOAD_LEAD_SEC, 200)).toBe(true);
    expect(preloadDue(0, 20)).toBe(true); // a short track preloads at once
    expect(preloadDue(Number.NaN, 200)).toBe(false);
  });
  it("the gapless start waits out what is left of the track, less the lead, at the play rate", () => {
    expect(gaplessDelayMs(1, 1, 0)).toBe(1000);
    expect(gaplessDelayMs(1, 1, 30)).toBe(970);
    expect(gaplessDelayMs(1, 2, 0)).toBe(500);
    expect(gaplessDelayMs(0.01, 1, 30)).toBe(0);
    expect(gaplessDelayMs(1, 0, 0)).toBe(1000); // a bad rate counts as 1
  });
});

describe("the fade curve", () => {
  it("progress follows the outgoing element's playhead, so a pause freezes it", () => {
    expect(fadeProgress(194, 194, 6)).toBe(0);
    expect(fadeProgress(197, 194, 6)).toBe(0.5);
    expect(fadeProgress(205, 194, 6)).toBe(1);
    expect(fadeProgress(190, 194, 6)).toBe(0);
    expect(fadeProgress(195, 194, 0)).toBe(1);
  });
  it("starts with only the outgoing track and ends with only the incoming one, at the slider's gain", () => {
    for (const v of [1, 0.6]) {
      expect(crossfadeGains(0, v)).toEqual({ out: positionToGain(v), in: 0 });
      expect(crossfadeGains(1, v)).toEqual({ out: 0, in: positionToGain(v) });
    }
  });
  it("is equal power through the perceptual curve: the summed power stays at the slider's", () => {
    for (const v of [1, 0.7, 0.3]) {
      const g = positionToGain(v);
      for (let i = 0; i <= 20; i++) {
        const { out, in: inn } = crossfadeGains(i / 20, v);
        expect(out ** 2 + inn ** 2).toBeCloseTo(g ** 2, 9);
      }
    }
    // Half way each side is 3 dB down, not the 18 dB a straight slider-position ramp gives.
    const mid = crossfadeGains(0.5, 1);
    expect(20 * Math.log10(mid.in)).toBeCloseTo(-3.01, 1);
    expect(20 * Math.log10(positionToGain(0.5))).toBeCloseTo(-18.06, 1);
  });
  it("ramps monotonically", () => {
    let last = crossfadeGains(0, 1);
    for (let i = 1; i <= 50; i++) {
      const g = crossfadeGains(i / 50, 1);
      expect(g.in).toBeGreaterThanOrEqual(last.in);
      expect(g.out).toBeLessThanOrEqual(last.out);
      last = g;
    }
  });
  it("silences both at volume 0 and survives bad input", () => {
    expect(crossfadeGains(0.5, 0)).toEqual({ out: 0, in: 0 });
    expect(crossfadeGains(Number.NaN, 1)).toEqual({ out: 0, in: 1 });
  });
});

describe("the transition state machine", () => {
  const run = (s: TransitionState, ...evs: Parameters<typeof transitionAfter>[1][]) => evs.reduce(transitionAfter, s);
  const now = 1_000_000;
  const later = now + 24 * 3600 * 1000;

  it("idle -> preloading -> ready -> fading -> idle", () => {
    let s = run(IDLE, { type: "preload", trackId: 7 });
    expect(s).toEqual({ phase: "preloading", trackId: 7, expiresAt: null });
    s = run(s, { type: "resolved", expiresAt: later });
    expect(s).toEqual({ phase: "preloading", trackId: 7, expiresAt: later });
    s = run(s, { type: "canPlay" });
    expect(s).toEqual({ phase: "ready", trackId: 7, expiresAt: later });
    s = run(s, { type: "start", fadeStart: 194, fadeSec: 6 });
    expect(s).toEqual({ phase: "fading", fadeStart: 194, fadeSec: 6 });
    expect(run(s, { type: "fadeDone" })).toEqual(IDLE);
  });
  it("a canplay before the URL resolved (left over from an old source) doesn't make it ready", () => {
    expect(run(IDLE, { type: "preload", trackId: 7 }, { type: "canPlay" }).phase).toBe("preloading");
  });
  it("only a ready standby can start", () => {
    expect(run(IDLE, { type: "start", fadeStart: 0, fadeSec: 0 })).toEqual(IDLE);
    expect(run(IDLE, { type: "preload", trackId: 7 }, { type: "start", fadeStart: 0, fadeSec: 0 }).phase).toBe("preloading");
  });
  it("a failed preload stays failed for that track (the plain load takes over), until invalidated", () => {
    const s = run(IDLE, { type: "preload", trackId: 7 }, { type: "failed" });
    expect(s).toEqual({ phase: "failed", trackId: 7 });
    expect(run(s, { type: "preload", trackId: 7 })).toEqual(s); // no retry storm on every timeupdate
    expect(run(s, { type: "invalidate" })).toEqual(IDLE);
    expect(run(IDLE, { type: "preload", trackId: 7 }, { type: "resolved", expiresAt: later }, { type: "canPlay" }, { type: "failed" }).phase).toBe("failed");
  });
  it("no preload while a fade owns the other element", () => {
    const fading = run(IDLE, { type: "preload", trackId: 7 }, { type: "resolved", expiresAt: later }, { type: "canPlay" }, { type: "start", fadeStart: 0, fadeSec: 5 });
    expect(run(fading, { type: "preload", trackId: 8 })).toEqual(fading);
    expect(run(fading, { type: "failed" })).toEqual(fading);
  });
  it("a queue change makes the preload stale", () => {
    const ready: TransitionState = { phase: "ready", trackId: 7, expiresAt: later };
    expect(preloadStale(ready, 7)).toBe(false);
    expect(preloadStale(ready, 8)).toBe(true);
    expect(preloadStale(ready, null)).toBe(true);
    expect(preloadStale({ phase: "failed", trackId: 7 }, 8)).toBe(true);
    expect(preloadStale(IDLE, 8)).toBe(false);
    expect(preloadStale({ phase: "fading", fadeStart: 0, fadeSec: 3 }, 8)).toBe(false);
  });
  it("a preloaded URL close to expiry is not used: the plain load fetches a fresh one", () => {
    const ready = (expiresAt: number): TransitionState => ({ phase: "ready", trackId: 7, expiresAt });
    expect(standbyUsable(ready(later), 7, now)).toBe(true);
    expect(standbyUsable(ready(later), 8, now)).toBe(false);
    expect(standbyUsable(ready(now + PRELOAD_EXPIRY_MARGIN_MS - 1), 7, now)).toBe(false);
    expect(standbyUsable({ phase: "preloading", trackId: 7, expiresAt: later }, 7, now)).toBe(false);
  });
});

describe("events from two elements", () => {
  const ready: TransitionState = { phase: "ready", trackId: 7, expiresAt: 1 };
  const fading: TransitionState = { phase: "fading", fadeStart: 0, fadeSec: 5 };

  it("roles follow the active index and the phase", () => {
    expect(elementRole(0, 0, ready)).toBe("active");
    expect(elementRole(1, 0, ready)).toBe("standby");
    expect(elementRole(0, 1, fading)).toBe("fading");
    expect(elementRole(1, 0, IDLE)).toBe("idle");
    expect(elementRole(1, 0, { phase: "failed", trackId: 7 })).toBe("idle");
  });
  it("everything from the active element goes to the store", () => {
    for (const t of ["play", "playing", "pause", "waiting", "ended", "error", "timeupdate", "loadedmetadata"] as const) {
      expect(routeElementEvent("active", t)).toBe("store");
    }
  });
  it("the standby element never changes the store: only its readiness and failure count", () => {
    for (const t of ["play", "playing", "pause", "waiting", "ended", "timeupdate", "durationchange", "seeking"] as const) {
      expect(routeElementEvent("standby", t)).toBeNull();
    }
    expect(routeElementEvent("standby", "canplay")).toBe("canPlay");
    expect(routeElementEvent("standby", "canplaythrough")).toBe("canPlay");
    expect(routeElementEvent("standby", "loadedmetadata")).toBe("canPlay"); // primes it: WebKit may load no further while paused
    expect(routeElementEvent("standby", "error")).toBe("failed");
  });
  it("the fading element only drives the fade; its pause and ended don't stop the player", () => {
    expect(routeElementEvent("fading", "pause")).toBeNull();
    expect(routeElementEvent("fading", "playing")).toBeNull();
    expect(routeElementEvent("fading", "ended")).toBe("fadeDone");
    expect(routeElementEvent("fading", "error")).toBe("fadeDone");
    expect(routeElementEvent("fading", "timeupdate")).toBe("fadeTick");
  });
  it("a released element's events are ignored", () => {
    for (const t of ["pause", "error", "ended", "canplay"] as const) expect(routeElementEvent("idle", t)).toBeNull();
  });

  it("replays a crossfade: the outgoing element's pause and ended leave the store playing the new track", () => {
    // Element 0 plays track A; element 1 preloads B and takes over at the fade.
    let s: TransitionState = IDLE;
    let active = 0;
    let store = { status: "playing", wantsPlay: true, index: 0 };
    const feed = (el: number, type: Parameters<typeof routeElementEvent>[1], state: { paused: boolean; ended: boolean }) => {
      const route = routeElementEvent(elementRole(el, active, s), type);
      if (route === "store" && type !== "ended" && type !== "error" && type !== "timeupdate" && type !== "canplay" && type !== "canplaythrough"
        && type !== "loadedmetadata" && type !== "durationchange" && type !== "seeking") {
        const patch = audioEventPatch(type, { ...state, internal: false });
        if (patch) store = { ...store, ...patch };
      } else if (route && route !== "store" && route !== "fadeTick") s = transitionAfter(s, { type: route } as never);
    };
    s = transitionAfter(s, { type: "preload", trackId: 2 });
    feed(1, "pause", { paused: true, ended: false }); // the standby's own load: ignored
    s = transitionAfter(s, { type: "resolved", expiresAt: 9e15 });
    feed(1, "canplaythrough", { paused: true, ended: false });
    expect(s.phase).toBe("ready");
    s = transitionAfter(s, { type: "start", fadeStart: 194, fadeSec: 6 });
    active = 1;
    store = { ...store, index: 1 };
    feed(1, "playing", { paused: false, ended: false });
    feed(0, "pause", { paused: true, ended: true }); // the old track ran out
    feed(0, "ended", { paused: true, ended: true });
    expect(s).toEqual(IDLE);
    expect(store).toMatchObject({ status: "playing", wantsPlay: true, index: 1 });
    // A system pause of the (new) active element still ends the intent to play.
    feed(1, "pause", { paused: true, ended: false });
    expect(store).toMatchObject({ status: "paused", wantsPlay: false, index: 1 });
  });
});
