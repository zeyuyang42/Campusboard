import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayState } from "@bc/core";
import { boot, flush, tracks, useFakeTimers, type Harness } from "./harness";

let h: Harness;
let persist: typeof import("../src/player/persist");
const list = tracks(3);

beforeEach(async () => {
  useFakeTimers();
  h = await boot();
  h.core.state = {
    current_track_id: list[1].id, position_sec: 42, queue: list.map(h.toQueueTrack), queue_index: 1,
    shuffle: false, repeat: "all", volume: 0.125,
  };
  persist = await import("../src/player/persist");
  await persist.initPersistence();
  await flush();
});
afterEach(() => { vi.useRealTimers(); });

/** Start the restored track playing, as the element would report it. */
function play(at = 0) {
  h.state().play();
  h.active().emit("playing", { currentTime: at });
}

describe("restore on launch", () => {
  it("restores the queue, the slider position from the saved gain, paused at the saved position", () => {
    expect(h.state()).toMatchObject({ index: 1, volume: 0.5, repeat: "all", shuffle: false, status: "paused", wantsPlay: false, position: 42 });
    expect(h.state().queue.map((t) => t.id)).toEqual(list.map((t) => t.id));
    const el = h.active();
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledWith(list[1].id, false);
    expect(el.src).toContain(`/stream/${list[1].id}`);
    expect(el.calls.play).toBe(0);
    expect(el.volume).toBe(0.125);
    el.emit("loadedmetadata", { duration: 100, readyState: 1 });
    expect(el.currentTime).toBe(42);
  });

  it("an unreadable play state leaves the player empty", async () => {
    h = await boot();
    h.core.playState.mockRejectedValueOnce(new Error("db"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await (await import("../src/player/persist")).initPersistence();
    expect(h.state()).toMatchObject({ queue: [], status: "idle" });
    expect(warn).toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("a change saves the full state once, 400 ms after the last change", async () => {
    h.state().cycleRepeat(); // all -> one
    vi.advanceTimersByTime(399);
    h.state().setVolume(1);
    vi.advanceTimersByTime(399);
    expect(h.core.savePlayState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(h.core.savePlayState).toHaveBeenCalledTimes(1);
    const saved = h.core.savePlayState.mock.calls[0][0] as PlayState;
    expect(saved).toMatchObject({ current_track_id: list[1].id, queue_index: 1, repeat: "one", volume: 1, position_sec: 42 });
    expect(saved.queue).toHaveLength(3);
  });

  it("saves the gain, not the slider position", async () => {
    h.state().setVolume(0.8);
    vi.advanceTimersByTime(400);
    await flush();
    const saved = h.core.savePlayState.mock.calls[0][0] as PlayState;
    expect(saved.volume).toBeCloseTo(0.512, 10);
  });

  it("a pause saves the full state", async () => {
    play(10);
    vi.advanceTimersByTime(400);
    expect(h.core.savePlayState).not.toHaveBeenCalled();
    h.state().pause();
    h.active().emit("pause");
    vi.advanceTimersByTime(400);
    await flush();
    expect(h.core.savePlayState).toHaveBeenCalledTimes(1);
    expect(h.core.savePlayState.mock.calls[0][0]).toMatchObject({ position_sec: 10 });
  });

  it("while playing, saves only the position every 5 s", async () => {
    play(12);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.savePlayPosition).toHaveBeenCalledTimes(1);
    expect(h.core.savePlayPosition).toHaveBeenLastCalledWith(list[1].id, 12, 1);
    h.active().currentTime = 17;
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.savePlayPosition).toHaveBeenLastCalledWith(list[1].id, 17, 1);
    expect(h.core.savePlayState).not.toHaveBeenCalled();
  });

  it("no position save while paused or while a full save is pending", async () => {
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.savePlayPosition).not.toHaveBeenCalled();
    play();
    vi.advanceTimersByTime(4900);
    h.state().cycleRepeat(); // a full save is pending across the 5 s mark
    vi.advanceTimersByTime(100);
    await flush();
    expect(h.core.savePlayPosition).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(300);
    await flush();
    expect(h.core.savePlayState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.savePlayPosition).toHaveBeenCalledTimes(1);
  });
});

describe("closing the window (#59)", () => {
  it("saves the full state, hides the window and replaces the pending save", async () => {
    expect(h.win.onCloseRequested).toHaveBeenCalledTimes(1);
    h.state().cycleRepeat(); // a save is pending
    const preventDefault = vi.fn();
    await h.win.closeHandler!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.core.savePlayState).toHaveBeenCalledTimes(1);
    expect(h.core.savePlayState.mock.calls[0][0]).toMatchObject({ repeat: "one" });
    expect(h.win.hide).toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    await flush();
    expect(h.core.savePlayState).toHaveBeenCalledTimes(1);
  });

  it("position saves carry on after a close that replaced a pending save (timer = null)", async () => {
    play(5);
    h.state().cycleRepeat();
    await h.win.closeHandler!({ preventDefault: () => undefined });
    vi.advanceTimersByTime(5000);
    await flush();
    expect(h.core.savePlayPosition).toHaveBeenCalledTimes(1);
  });
});
