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

  it("survives a restart: the saved queue entry keeps its radio details", async () => {
    const saved = episode();
    h.state().hydrate({ queue: [JSON.parse(JSON.stringify(saved))], index: 0, position: 1900, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    expect(h.state().current()).toEqual(saved);
    expect(h.core.radioStreamUrl).toHaveBeenCalledWith(SHOW.id, false);
  });
});
