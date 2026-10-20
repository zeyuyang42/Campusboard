import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { radioQueueTrack, type QueueTrack } from "@bc/core";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";
import type { FakeAudio } from "./fakeAudio";

// Resume long tracks and Radio episodes (#85).
let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const LONG = 3600;
const long = () => track({ duration: LONG });
const SHOW = { id: 1008, title: "Omasta", program: "Bandcamp Selects", image_id: 47798096, url: "https://bandcamp.com/radio/bandcamp-selects/1008", duration: 5459.84 };
const episode = (): QueueTrack => radioQueueTrack(SHOW);

/** The listener pauses: the store pauses the element and the element reports it. */
function pause(el: FakeAudio) {
  h.state().pause();
  el.emit("pause");
}
/** Play on for `sec` seconds, one timeupdate a second. */
function listen(el: FakeAudio, sec: number) {
  for (let i = 0; i < sec; i++) {
    vi.advanceTimersByTime(1000);
    el.emit("timeupdate", { currentTime: el.currentTime + 1 });
  }
}

describe("saving the point", () => {
  it("a pause saves a long track's playhead", async () => {
    const t = long();
    const el = await h.startPlaying([t], 0, LONG);
    el.emit("timeupdate", { currentTime: 2480 });
    pause(el);
    await flush();
    expect(h.core.saveResumePosition).toHaveBeenLastCalledWith(t.id, 2480);
    expect(h.core.resume.get(t.id)).toBe(2480);
  });

  it("skipping away saves it", async () => {
    const [a, b] = [long(), track()];
    const el = await h.startPlaying([a, b], 0, LONG);
    el.emit("timeupdate", { currentTime: 1500 });
    h.state().next();
    await flush();
    expect(h.core.resume.get(a.id)).toBe(1500);
    expect(h.state().current()?.id).toBe(b.id);
  });

  it("drops points in the first or last 30 s, and never saves a short track", async () => {
    const t = long();
    h.core.resume.set(t.id, 999);
    let el = await h.startPlaying([t], 0, LONG);
    el.currentTime = 10;
    pause(el);
    await flush();
    expect(h.core.resume.has(t.id)).toBe(false);
    expect(h.core.clearResumePosition).toHaveBeenCalledWith(t.id);

    el = await h.startPlaying([t], 0, LONG);
    el.currentTime = LONG - 10;
    pause(el);
    await flush();
    expect(h.core.resume.has(t.id)).toBe(false);

    const short = track({ duration: 20 * 60 });
    el = await h.startPlaying([short], 0, 20 * 60);
    el.currentTime = 600;
    pause(el);
    await flush();
    expect(h.core.saveResumePosition).not.toHaveBeenCalled();
    expect(h.core.resumePosition).not.toHaveBeenCalledWith(short.id);
  });

  it("finishing the track clears it; repeat-one then replays from the top", async () => {
    const t = long();
    const el = await h.startPlaying([t], 0, LONG);
    h.state().cycleRepeat(); h.state().cycleRepeat(); // off -> all -> one
    el.emit("timeupdate", { currentTime: LONG - 40 });
    pause(el);
    await flush();
    expect(h.core.resume.get(t.id)).toBe(LONG - 40);
    h.state().play();
    el.end();
    await flush();
    expect(h.core.resume.has(t.id)).toBe(false);
    expect(el.currentTime).toBe(0);
    expect(el.calls.play).toBeGreaterThan(1);
  });

  it("a track skipped before its metadata keeps its old point", async () => {
    const [a, b] = [long(), track()];
    h.core.resume.set(a.id, 2480);
    h.state().playTracks([a, b]);
    await flush();
    h.state().next(); // the element of `a` is still at 0: that is not where the listener was
    await flush();
    expect(h.core.resume.get(a.id)).toBe(2480);
    expect(h.core.clearResumePosition).not.toHaveBeenCalled();
  });

  it("the 5 s position save and closing the window save it (persist.ts)", async () => {
    const t = long();
    const persist = await import("../src/player/persist");
    await persist.initPersistence();
    const el = await h.startPlaying([t], 0, LONG);
    el.emit("timeupdate", { currentTime: 100 });
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.resume.get(t.id)).toBe(100);
    el.currentTime = 160;
    await h.win.closeHandler!({ preventDefault: () => undefined });
    expect(h.core.resume.get(t.id)).toBe(160);
    expect(h.win.hide).toHaveBeenCalled();
  });
});

describe("resuming", () => {
  it("starts at the saved point with a hint that goes after 8 s", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    const el = await h.startPlaying([t], 0, LONG);
    expect(el.currentTime).toBe(2480);
    expect(h.state().resumedAt).toBe(2480);
    vi.advanceTimersByTime(7900);
    expect(h.state().resumedAt).toBe(2480);
    vi.advanceTimersByTime(100);
    expect(h.state().resumedAt).toBeNull();
  });

  it("any seek hides the hint and keeps the new position", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    const el = await h.startPlaying([t], 0, LONG);
    h.state().seekBy(15);
    expect(h.state().resumedAt).toBeNull();
    expect(el.currentTime).toBe(2495);
  });

  it("Start over goes to the top and forgets the point", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    const el = await h.startPlaying([t], 0, LONG);
    h.state().startOver();
    await flush();
    expect(el.currentTime).toBe(0);
    expect(h.state().resumedAt).toBeNull();
    expect(h.core.resume.has(t.id)).toBe(false);
  });

  it("a seek made while the URL resolves wins over the saved point", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    h.state().playTracks([t]);
    h.state().seek(60);
    await flush();
    const el = h.active();
    el.emit("loadedmetadata", { duration: LONG, readyState: 1 });
    expect(el.currentTime).toBe(60);
    expect(h.state().resumedAt).toBeNull();
  });

  it("the restore at launch keeps its own position and shows no hint", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    h.state().hydrate({ queue: [h.toQueueTrack(t)], index: 0, position: 2600, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    const el = h.active();
    el.emit("loadedmetadata", { duration: LONG, readyState: 1 });
    expect(el.currentTime).toBe(2600);
    expect(h.state().resumedAt).toBeNull();
    expect(h.core.resumePosition).not.toHaveBeenCalled();
  });

  it("a resumed play still counts in listening history", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    const el = await h.startPlaying([t], 0, LONG);
    listen(el, 245);
    await flush();
    expect(h.core.recordPlay).toHaveBeenCalledTimes(1);
    expect(h.core.recordPlay).toHaveBeenCalledWith(t.id, expect.any(Number));
  });

  it("resumes an offline copy too (#77)", async () => {
    const t = long();
    h.core.local.set(t.id, "asset://localhost/x.mp3");
    h.core.resume.set(t.id, 2480);
    const el = await h.startPlaying([t], 0, LONG);
    expect(el.src).toBe("asset://localhost/x.mp3");
    expect(el.currentTime).toBe(2480);
  });

  it("a retry after a media error keeps the resumed point, not 0", async () => {
    const t = long();
    h.core.resume.set(t.id, 2480);
    h.state().playTracks([t]);
    await flush();
    const el = h.active();
    el.emit("error"); // before the metadata: the point is still pending
    await flush();
    el.emit("loadedmetadata", { duration: LONG, readyState: 1 });
    expect(el.currentTime).toBe(2480);
    expect(h.core.resume.get(t.id)).toBe(2480);
  });
});

describe("with gapless and crossfade (#57)", () => {
  it("a next track with a saved point is not preloaded: it loads the plain way and starts there", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const [a, b] = [track({ duration: 100 }), long()];
    h.core.resume.set(b.id, 2480);
    const el = await h.startPlaying([a, b], 0, 100);
    el.emit("timeupdate", { currentTime: 80 });
    await flush();
    expect(h.standby().src).toBe("");
    expect(h.transitionInfo().phase).toBe("failed");
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalledWith(b.id, false);
    el.end();
    await flush();
    expect(h.state().current()?.id).toBe(b.id);
    expect(h.active()).toBe(el); // the same element, the plain way
    el.emit("loadedmetadata", { duration: LONG, readyState: 1 });
    expect(el.currentTime).toBe(2480);
    expect(h.state().resumedAt).toBe(2480);
  });

  it("a long track without a point still goes gapless, and is saved after the handover", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const [a, b] = [track({ duration: 100 }), long()];
    const el = await h.startPlaying([a, b], 0, 100);
    el.emit("timeupdate", { currentTime: 80 });
    await flush();
    const standby = h.standby();
    expect(standby.src).toContain(`/stream/${b.id}`);
    standby.emit("loadedmetadata", { duration: LONG, readyState: 1 });
    standby.emit("canplay");
    vi.advanceTimersByTime(5000);
    el.end();
    await flush();
    expect(h.active()).toBe(standby);
    expect(h.state().current()?.id).toBe(b.id);
    standby.emit("timeupdate", { currentTime: 600 });
    pause(standby);
    await flush();
    expect(h.core.resume.get(b.id)).toBe(600);
  });
});

describe("with the sleep timer (#70)", () => {
  it("the timer's pause saves the point", async () => {
    const t = long();
    const el = await h.startPlaying([t], 0, LONG);
    el.currentTime = 1200;
    h.state().setSleep(15);
    vi.advanceTimersByTime(15 * 60_000);
    expect(el.paused).toBe(true);
    el.emit("pause"); // as the element reports the store's pause
    await flush();
    expect(h.core.resume.get(t.id)).toBe(1200);
  });

  it("stopping at the end of a track readies the next long one at its point, paused", async () => {
    const [a, b] = [track({ duration: 100 }), long()];
    h.core.resume.set(b.id, 2480);
    const el = await h.startPlaying([a, b], 0, 100);
    h.state().setSleep("track");
    el.end();
    await flush();
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: false });
    h.active().emit("loadedmetadata", { duration: LONG, readyState: 1 });
    expect(h.active().currentTime).toBe(2480);
    expect(h.active().paused).toBe(true);
  });
});

describe("a Radio episode (#76)", () => {
  it("is keyed by its show (the negative queue id), saved on pause and resumed next time", async () => {
    let el = await h.startPlaying([episode()], 0, SHOW.duration);
    el.emit("timeupdate", { currentTime: 1900 });
    pause(el);
    await flush();
    expect(h.core.resume.get(-SHOW.id)).toBe(1900);

    el = await h.startPlaying([track(), episode()], 1, SHOW.duration);
    expect(h.core.radioStreamUrl).toHaveBeenLastCalledWith(SHOW.id, false);
    expect(el.currentTime).toBe(1900);
    expect(h.state().resumedAt).toBe(1900);
  });

  it("finishing the episode clears its point", async () => {
    h.core.resume.set(-SHOW.id, 1900);
    const el = await h.startPlaying([episode()], 0, SHOW.duration);
    el.end();
    await flush();
    expect(h.core.resume.has(-SHOW.id)).toBe(false);
  });
});
