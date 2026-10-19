import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crossfadeGains, positionToGain, radioQueueTrack, SLEEP_FADE_SEC } from "@bc/core";
import { boot, flush, track, tracks, useFakeTimers, type Harness } from "./harness";
import type { FakeAudio } from "./fakeAudio";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const MIN = 60_000;

/** The active element reports progress as a real one would while it plays. */
const at = (el: FakeAudio, sec: number) => el.emit("timeupdate", { currentTime: sec });

/** After a load, bring the new active track to "playing". */
async function playing(duration = 100) {
  await flush();
  const el = h.active();
  el.emit("loadedmetadata", { duration, readyState: 1 });
  await el.play();
  el.emit("play");
  el.emit("playing");
  return el;
}

/** The pause after the timer: paused, the gain back at the slider's level, the timer off. */
function expectStopped(el: FakeAudio, volume = h.state().volume) {
  expect(el.paused).toBe(true);
  expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false, sleep: null, sleepLeft: null });
  expect(h.active().volume).toBeCloseTo(positionToGain(volume), 10);
}

describe("a minutes timer", () => {
  it("counts down, fades over the last 10 s through the volume curve, pauses and gives the volume back", async () => {
    const el = await h.startPlaying(tracks(1), 0, 3600);
    h.state().setVolume(0.8);
    h.state().setSleep(15);
    expect(h.state().sleep).toMatchObject({ kind: "minutes", minutes: 15 });
    expect(h.state().sleepLeft).toBe(900);

    vi.advanceTimersByTime(5 * MIN);
    expect(h.state().sleepLeft).toBe(600);
    expect(el.volume).toBeCloseTo(positionToGain(0.8), 10);

    vi.advanceTimersByTime(10 * MIN - SLEEP_FADE_SEC * 1000 / 2); // half way through the fade
    expect(el.volume).toBeCloseTo(positionToGain(0.4), 10);
    expect(el.paused).toBe(false);

    vi.advanceTimersByTime(SLEEP_FADE_SEC * 1000 / 2);
    expectStopped(el, 0.8);
    expect(h.state().volume).toBe(0.8); // the slider never moved

    // The next play is at the listener's level, and nothing stops it again.
    h.state().play();
    vi.advanceTimersByTime(20 * MIN);
    expect(el.paused).toBe(false);
    expect(el.volume).toBeCloseTo(positionToGain(0.8), 10);
  });

  it("still stops in a hidden window, where timers may never fire: timeupdate drives it", async () => {
    const el = await h.startPlaying(tracks(1), 0, 3600);
    h.state().setSleep(30);
    vi.setSystemTime(Date.now() + 30 * MIN - 5000); // time passes, but no timer runs
    at(el, 600);
    expect(el.volume).toBeCloseTo(positionToGain(0.5), 10);
    vi.setSystemTime(Date.now() + 5000);
    at(el, 605);
    expectStopped(el);
  });

  it("Off cancels it, mid-fade too, and restores the level at once", async () => {
    const el = await h.startPlaying(tracks(1), 0, 3600);
    h.state().setSleep(15);
    vi.advanceTimersByTime(15 * MIN - 3000);
    expect(el.volume).toBeLessThan(0.1);
    h.state().setSleep("off");
    expect(h.state()).toMatchObject({ sleep: null, sleepLeft: null, wantsPlay: true });
    expect(el.volume).toBe(1);
    vi.advanceTimersByTime(30 * MIN);
    expect(el.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // no ticker left behind
  });

  it("a track that ends during the fade stops there instead of starting the next one", async () => {
    const list = tracks(2);
    const el = await h.startPlaying(list);
    h.state().setSleep(15);
    vi.setSystemTime(Date.now() + 15 * MIN - 4000);
    at(el, 99);
    el.end();
    expectStopped(el);
    expect(h.state().index).toBe(1); // ready for Play, not playing
    await flush();
    expect(h.active().paused).toBe(true);
  });

  it("choosing another length restarts the countdown", async () => {
    await h.startPlaying(tracks(1), 0, 3600);
    h.state().setSleep(15);
    vi.advanceTimersByTime(MIN);
    h.state().setSleep(45);
    expect(h.state().sleepLeft).toBe(45 * 60);
  });
});

describe("end of track", () => {
  it("fades over the track's last 10 s and stops at its end, with the next track loaded but paused", async () => {
    const list = tracks(3);
    const el = await h.startPlaying(list);
    h.state().setSleep("track");
    at(el, 75);
    await flush();
    expect(h.transitionInfo().phase).toBe("idle"); // nothing preloads for a start that won't happen
    at(el, 95);
    expect(el.volume).toBeCloseTo(positionToGain(0.5), 10);
    el.end();
    expectStopped(el);
    expect(h.state().index).toBe(1);
    await flush();
    expect(h.active().src).toContain(`/stream/${list[1].id}`);
    expect(h.active().paused).toBe(true);
  });

  it("Next during the fade gives the new track its full level", async () => {
    const el = await h.startPlaying(tracks(3));
    h.state().setSleep("track");
    at(el, 95);
    h.state().next();
    const el2 = await playing();
    expect(el2.volume).toBe(1);
    at(el2, 10);
    expect(el2.volume).toBe(1);
  });

  it("with repeat-one it stops instead of replaying", async () => {
    const el = await h.startPlaying(tracks(2));
    h.state().cycleRepeat(); h.state().cycleRepeat();
    expect(h.state().repeat).toBe("one");
    h.state().setSleep("track");
    el.end();
    expectStopped(el);
    expect(h.state().index).toBe(0);
  });
});

describe("end of album", () => {
  it("plays through the album and stops after its last track", async () => {
    const list = [track({ album_id: 1 }), track({ album_id: 1 }), track({ album_id: 2 })];
    h.state().setPlayback({ gapless: false });
    const el = await h.startPlaying(list);
    h.state().setSleep("album");
    at(el, 95);
    expect(el.volume).toBe(1); // not the album's end
    el.end();
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
    const el2 = await playing();
    at(el2, 95);
    expect(el2.volume).toBeCloseTo(positionToGain(0.5), 10);
    el2.end();
    expectStopped(el2);
    expect(h.state().index).toBe(2);
  });
});

describe("review fixes (#80)", () => {
  it("end of album stops when repeat-all wraps back into the same album", async () => {
    const list = tracks(2, { album_id: 5 });
    h.state().setPlayback({ gapless: false });
    const el = await h.startPlaying(list);
    h.state().cycleRepeat();
    expect(h.state().repeat).toBe("all");
    h.state().setSleep("album");
    el.end();
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true }); // not the album's end yet
    const el2 = await playing();
    at(el2, 95);
    expect(el2.volume).toBeCloseTo(positionToGain(0.5), 10);
    el2.end();
    expectStopped(el2);
    expect(h.state().index).toBe(0); // wrapped to the start, paused
  });

  it("end of album with repeat-all on a one-track queue stops too, and no gapless start loops it", async () => {
    const el = await h.startPlaying(tracks(1));
    h.state().cycleRepeat();
    h.state().setSleep("album");
    at(el, 75);
    await flush();
    expect(h.transitionInfo().phase).toBe("idle");
    el.end();
    expectStopped(el);
  });

  it("a track that fails during its end-of-track fade stops the timer instead of playing the next one", async () => {
    const list = tracks(3);
    const el = await h.startPlaying(list);
    h.state().setSleep("track");
    at(el, 95);
    el.emit("error"); // retried once with a fresh URL, at the faded level
    await flush();
    expect(h.active().volume).toBeLessThan(1);
    el.emit("error"); // failed again: that is the end of this track
    await flush();
    vi.advanceTimersByTime(2000);
    await flush();
    expect(h.state()).toMatchObject({ index: 0, wantsPlay: false, sleep: null });
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalledWith(list[1].id, expect.anything());
    expect(h.active().volume).toBe(1);
  });

  it("the bar's menu offers End of album only in album order (not with shuffle)", async () => {
    const { sleepMenu } = await import("../src/components/PlayerBar");
    const album = () => sleepMenu(false).find((i) => "label" in i && i.label === "End of album") as { disabled?: boolean };
    expect(album().disabled).toBeFalsy();
    h.state().toggleShuffle();
    expect(album().disabled).toBe(true);
    expect(sleepMenu(true).some((i) => "label" in i && i.label === "End of episode")).toBe(true);
  });
});

describe("gapless and crossfade (#57)", () => {
  async function preloadNext(el: FakeAudio, sec: number) {
    at(el, sec);
    await flush();
    const sb = h.standby();
    sb.emit("loadedmetadata", { duration: 100, readyState: 1 });
    sb.emit("timeupdate", { currentTime: 0.3 });
    expect(h.transitionInfo().phase).toBe("ready");
    return sb;
  }

  it("a crossfade prepared before the timer was set never starts", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const el = await h.startPlaying([track({ album_id: 1 }), track({ album_id: 2 })]);
    const sb = await preloadNext(el, 70);
    h.state().setSleep("album");
    at(el, 95); // the crossfade's point
    expect(h.active()).toBe(el);
    expect(sb.paused).toBe(true);
    at(el, 99);
    el.end();
    expectStopped(el);
    expect(h.transitionInfo().transitions).toHaveLength(0);
    expect(sb.paused).toBe(true);
  });

  it("a gapless start (armed or on 'ended') never happens", async () => {
    const el = await h.startPlaying(tracks(2));
    const sb = await preloadNext(el, 75);
    h.state().setSleep("track");
    at(el, 99.9);
    vi.advanceTimersByTime(200);
    expect(h.active()).toBe(el);
    el.end();
    expectStopped(el);
    expect(sb.paused).toBe(true);
    expect(h.transitionInfo().transitions).toHaveLength(0);
  });

  it("a minutes fade during a crossfade scales both gains, and the stop pauses both", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const el = await h.startPlaying([track({ album_id: 1 }), track({ album_id: 2 })]);
    const sb = await preloadNext(el, 70);
    at(el, 95);
    expect(h.active()).toBe(sb); // crossfading
    h.state().setSleep(15);
    vi.setSystemTime(Date.now() + 15 * MIN - 5000);
    el.currentTime = 97.5;
    sb.emit("timeupdate", { currentTime: 2.5 });
    const g = crossfadeGains(0.5, 0.5); // half way through the crossfade, half way through the sleep fade
    expect(el.volume).toBeCloseTo(g.out, 5);
    expect(sb.volume).toBeCloseTo(g.in, 5);
    vi.setSystemTime(Date.now() + 5000);
    sb.emit("timeupdate", { currentTime: 2.6 });
    expect([el.paused, sb.paused]).toEqual([true, true]);
    expect(h.state()).toMatchObject({ wantsPlay: false, sleep: null });
  });
});

describe("radio (#76)", () => {
  const SHOW = { id: 1008, title: "Omasta", program: "Bandcamp Selects", image_id: 47798096, url: "https://bandcamp.com/radio/bandcamp-selects/1008", duration: 5459.84 };

  it("end of track is the end of the episode", async () => {
    const episodes = [radioQueueTrack(SHOW), radioQueueTrack({ ...SHOW, id: 1009 })];
    h.state().hydrate({ queue: episodes, index: 0, position: 0, volume: 1, shuffle: false, repeat: "off" });
    h.state().play();
    const el = await playing(SHOW.duration);
    h.state().setSleep("track");
    at(el, SHOW.duration - 5);
    expect(el.volume).toBeCloseTo(positionToGain(0.5), 10);
    el.end();
    expectStopped(el);
  });

  it("end of album stops after the episode too: each episode is its own", async () => {
    const episodes = [radioQueueTrack(SHOW), radioQueueTrack({ ...SHOW, id: 1009 })];
    h.state().hydrate({ queue: episodes, index: 0, position: 0, volume: 1, shuffle: false, repeat: "off" });
    h.state().play();
    const el = await playing(SHOW.duration);
    h.state().setSleep("album");
    el.end();
    expectStopped(el);
  });
});

describe("the Controls menu", () => {
  it("sets and cancels the timer through the menu ids", async () => {
    const { runMenuAction } = await import("../src/lib/appMenu");
    expect(runMenuAction("sleep:30")).toBe(true);
    expect(h.state().sleep).toMatchObject({ kind: "minutes", minutes: 30 });
    runMenuAction("sleep:album");
    expect(h.state().sleep).toEqual({ kind: "album" });
    runMenuAction("sleep:off");
    expect(h.state().sleep).toBeNull();
  });
});
