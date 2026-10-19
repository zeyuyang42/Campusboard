import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { radioQueueTrack } from "@bc/core";
import { boot, flush, track, tracks, useFakeTimers, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const localUrl = (id: number) => `asset://localhost/offline/${id}.mp3`;

describe("offline copies in the player (#2)", () => {
  it("plays a downloaded track from its file without asking for a stream URL", async () => {
    const [a, b] = tracks(2);
    h.core.local.set(a.id, localUrl(a.id));
    const el = await h.startPlaying([a, b]);
    expect(h.core.localTrackUrl).toHaveBeenCalledWith(a.id);
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalled();
    expect(el.src).toBe(localUrl(a.id));
    expect(h.state()).toMatchObject({ status: "playing", index: 0 });
    // The next one has no copy: streamed as before.
    h.state().next();
    await flush();
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledWith(b.id, false);
    expect(h.active().src).toContain(`/stream/${b.id}`);
  });

  it("a media error on the file falls back to the stream", async () => {
    const t = track();
    h.core.local.set(t.id, localUrl(t.id));
    const el = await h.startPlaying([t]);
    el.emit("error");
    await flush();
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledWith(t.id, true);
    expect(el.src).toContain(`/stream/${t.id}?force`);
  });

  it("preloads a downloaded next track from its file for a gapless switch", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const [a, b] = tracks(2);
    h.core.local.set(b.id, localUrl(b.id));
    const el = await h.startPlaying([a, b]);
    el.emit("timeupdate", { currentTime: 75 });
    await flush();
    const sb = h.standby();
    expect(h.transitionInfo().phase).toBe("preloading");
    expect(sb.src).toBe(localUrl(b.id));
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1); // only the first track's
    sb.emit("loadedmetadata", { duration: 100, readyState: 1 });
    sb.emit("timeupdate", { currentTime: 0.3 });
    expect(h.transitionInfo().phase).toBe("ready");
    el.end({ currentTime: 100 });
    expect(h.active()).toBe(sb);
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
  });

  it("offline: skips the tracks without a copy, quickly, and plays the downloaded ones", async () => {
    const list = tracks(4);
    h.core.local.set(list[2].id, localUrl(list[2].id));
    h.core.offline = true;
    h.state().playTracks(list);
    await flush(); // A: the stream URL fetch finds no network
    expect(h.state().error).toContain(list[0].title);
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(800);
    await flush(); // B: known offline, fails without another fetch
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1);
    expect(h.state().error).toMatch(/offline/i);
    vi.advanceTimersByTime(800);
    await flush(); // C: downloaded, plays
    expect(h.state()).toMatchObject({ index: 2, wantsPlay: true });
    expect(h.active().src).toBe(localUrl(list[2].id));
    h.active().emit("playing");
    expect(h.state().status).toBe("playing");
  });

  it("offline with nothing downloaded: tries each track once and stops", async () => {
    const list = tracks(3);
    h.core.offline = true;
    h.state().playTracks(list);
    for (let i = 0; i < 4; i++) { await flush(); vi.advanceTimersByTime(800); }
    await flush();
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1);
  });

  it("back online after the hold: streams again", async () => {
    const [a, b] = tracks(2);
    h.core.offline = true;
    h.state().playTracks([a, b]);
    await flush();
    h.core.offline = false;
    vi.advanceTimersByTime(31_000);
    h.state().playTracks([b]);
    await flush();
    expect(h.active().src).toContain(`/stream/${b.id}`);
  });

  it("a radio episode never looks for an offline copy", async () => {
    const ep = radioQueueTrack({ id: 1008, title: "Omasta", program: "Bandcamp Selects", image_id: 1, url: "https://bandcamp.com/radio/x/1008", duration: 5000 });
    await h.startPlaying([ep], 0, 5000);
    expect(h.core.localTrackUrl).not.toHaveBeenCalled();
    expect(h.core.radioStreamUrl).toHaveBeenCalled();
  });
});
