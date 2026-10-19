import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { radioQueueTrack, type QueueTrack } from "@bc/core";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const SHOW = { id: 1008, title: "Omasta", program: "Bandcamp Selects", image_id: 47798096, url: "https://bandcamp.com/radio/bandcamp-selects/1008", duration: 5459.84 };
const episode = (p: Partial<typeof SHOW> = {}): QueueTrack => radioQueueTrack({ ...SHOW, ...p });

/** Play the element on for `sec` seconds, one timeupdate a second, as a real one reports. */
function listen(el: ReturnType<Harness["active"]>, sec: number) {
  for (let i = 0; i < sec; i++) {
    vi.advanceTimersByTime(1000);
    el.emit("timeupdate", { currentTime: el.currentTime + 1 });
  }
}

describe("a radio episode in the player (#44)", () => {
  it("resolves its stream through the radio function, not the track one", async () => {
    const el = await h.startPlaying([episode()], 0, SHOW.duration);
    expect(h.core.radioStreamUrl).toHaveBeenCalledWith(SHOW.id, false);
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalled();
    expect(el.src).toContain("stream_redirect?show=1008");
    expect(h.state()).toMatchObject({ status: "playing", index: 0 });
    expect(h.state().current()?.radio?.show_id).toBe(SHOW.id);
  });

  it("retries once with a fresh page after a media error (an expired URL)", async () => {
    const el = await h.startPlaying([episode()], 0, SHOW.duration);
    el.emit("error");
    await flush();
    expect(h.core.radioStreamUrl).toHaveBeenLastCalledWith(SHOW.id, true);
    expect(el.src).toContain("&force");
  });

  it("is not counted in listening history; a library track still is", async () => {
    const el = await h.startPlaying([episode()], 0, SHOW.duration);
    listen(el, 300);
    await flush();
    expect(h.core.recordPlay).not.toHaveBeenCalled();

    const t = track({ duration: 100 });
    const el2 = await h.startPlaying([t], 0, 100);
    listen(el2, 60);
    await flush();
    expect(h.core.recordPlay).toHaveBeenCalledWith(t.id, expect.any(Number));
  });

  it("queues next to library tracks and preloads through the radio function", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const t = track({ duration: 100 });
    const el = await h.startPlaying([t], 0, 100);
    expect(h.state().enqueueLast([episode()])).toBe(1);
    el.emit("timeupdate", { currentTime: 80 });
    await flush();
    expect(h.core.radioStreamUrl).toHaveBeenCalledWith(SHOW.id, false);
    expect(h.standby().src).toContain("stream_redirect?show=1008");
  });

  it("survives a restart without a request until Play, then resumes where it was", async () => {
    const saved = episode();
    h.state().hydrate({ queue: [JSON.parse(JSON.stringify(saved))], index: 0, position: 1900, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    expect(h.state().current()).toEqual(saved);
    expect(h.state()).toMatchObject({ status: "paused", position: 1900, duration: SHOW.duration });
    expect(h.core.radioStreamUrl).not.toHaveBeenCalled();

    h.state().play();
    await flush();
    expect(h.core.radioStreamUrl).toHaveBeenCalledWith(SHOW.id, false);
    const el = h.active();
    el.emit("loadedmetadata", { duration: SHOW.duration, readyState: 1 });
    expect(el.currentTime).toBe(1900);
  });

  it("drops a restored entry whose radio field is malformed", async () => {
    const good = track();
    const bad = { ...episode(), radio: { show_id: "1008", image_id: null, program: "x" } } as unknown as QueueTrack;
    h.state().hydrate({ queue: [bad, good as QueueTrack], index: 1, position: 0, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    expect(h.state().queue.map((t) => t.id)).toEqual([good.id]);
  });

  it("a media error mid-episode resumes at the same point, not from the top", async () => {
    const el = await h.startPlaying([episode()], 0, SHOW.duration);
    vi.advanceTimersByTime(300);
    el.emit("timeupdate", { currentTime: 1900 });
    el.emit("error");
    await flush();
    expect(h.core.radioStreamUrl).toHaveBeenLastCalledWith(SHOW.id, true);
    expect(el.currentTime).toBe(0); // the new source starts from the top...
    el.emit("loadedmetadata", { duration: SHOW.duration, readyState: 1 });
    expect(el.currentTime).toBe(1900); // ...and jumps back to where it failed
  });
});

describe("a pending seek belongs to its track (#75)", () => {
  it("a seek during the URL fetch, then Next: the next track starts at 0", async () => {
    const list = [track(), track()];
    h.state().playTracks(list);
    h.state().seek(40); // no source yet: kept for later
    h.state().next();
    await flush();
    const el = h.active();
    expect(h.state().current()?.id).toBe(list[1].id);
    el.emit("loadedmetadata", { duration: 100, readyState: 1 });
    expect(el.currentTime).toBe(0);
  });

  it("a seek during the URL fetch still applies to that track", async () => {
    h.state().playTracks([track(), track()]);
    h.state().seek(40);
    await flush();
    const el = h.active();
    el.emit("loadedmetadata", { duration: 100, readyState: 1 });
    expect(el.currentTime).toBe(40);
  });

  it("a restored position is not applied to a different track picked before it loaded", async () => {
    const list = [track(), track()];
    h.state().hydrate({ queue: list.map((t) => ({ ...t, album_title: "A", artist_name: "B", art_id: null })), index: 0, position: 70, volume: 1, shuffle: false, repeat: "off" });
    h.state().jumpTo(1);
    await flush();
    const el = h.active();
    el.emit("loadedmetadata", { duration: 100, readyState: 1 });
    expect(el.currentTime).toBe(0);
  });
});
