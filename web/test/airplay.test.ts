import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FakeAudio } from "./fakeAudio";
import { boot, flush, tracks, useFakeTimers, type Harness } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// AirPlay output (#42): WebKit's picker on the element that plays the current track.
let h: Harness;
afterEach(() => {
  FakeAudio.airPlay = false;
  vi.useRealTimers();
});

describe("without WebKit's picker API (Chromium, browser mode)", () => {
  it("never reports AirPlay and the action does nothing", async () => {
    useFakeTimers();
    h = await boot();
    await h.startPlaying(tracks(2));
    h.active().dispatchEvent(Object.assign(new Event("webkitplaybacktargetavailabilitychanged"), { availability: "available" }));
    expect(h.state()).toMatchObject({ airplayAvailable: false, airplayActive: false });
    expect(h.state().showAirPlayPicker()).toBe(false);
  });
});

describe("with WebKit's picker API", () => {
  beforeEach(async () => {
    FakeAudio.airPlay = true;
    useFakeTimers();
    h = await boot();
  });

  it("follows the availability WebKit reports", async () => {
    h.els[0].targets(true);
    expect(h.state().airplayAvailable).toBe(true);
    h.els[0].targets(false);
    expect(h.state().airplayAvailable).toBe(false);
  });

  it("opens the picker on the active element, and only once it has metadata", async () => {
    h.state().playTracks(tracks(2));
    await flush();
    expect(h.state().showAirPlayPicker()).toBe(false); // WebKit on macOS ignores it before metadata
    const el = await h.startPlaying(tracks(2));
    expect(h.state().showAirPlayPicker()).toBe(true);
    expect(el.calls.picker).toBe(1);
    expect(h.standby().calls.picker).toBe(0);
  });

  it("reports the wireless route of the active element", async () => {
    const el = await h.startPlaying(tracks(2));
    el.wireless(true);
    expect(h.state()).toMatchObject({ airplayActive: true, airplayAvailable: true });
    h.standby().wireless(true); // not the element that plays: changes nothing
    el.wireless(false);
    expect(h.state().airplayActive).toBe(false);
  });

  it("while routed, the next track loads into the same element instead of a gapless handover", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const list = tracks(3);
    const el = await h.startPlaying(list);
    el.wireless(true);
    el.emit("timeupdate", { currentTime: 75 });
    await flush();
    expect(h.transitionInfo().phase).toBe("idle"); // no preload into the other element
    el.end({ currentTime: 100 });
    await flush();
    expect(h.active()).toBe(el);
    expect(el.src).toContain(`/stream/${list[1].id}`);
    expect(h.state()).toMatchObject({ index: 1, airplayActive: true });
    expect(h.transitionInfo().transitions).toHaveLength(0);
    expect(h.state().gapless).toBe(true); // the saved setting is untouched
  });

  it("going wireless drops a preload already made, and leaving AirPlay brings gapless back", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const el = await h.startPlaying(tracks(3));
    el.emit("timeupdate", { currentTime: 75 });
    await flush();
    expect(h.transitionInfo().phase).toBe("preloading");
    el.wireless(true);
    expect(h.transitionInfo().phase).toBe("idle");
    expect(h.standby().src).toBe("");

    el.wireless(false);
    el.emit("timeupdate", { currentTime: 76 });
    await flush();
    expect(h.transitionInfo().phase).toBe("preloading");
  });

  it("holds handovers while the picker may still be open, then lets them run again", async () => {
    h.state().setPlayback({ gapless: true, crossfadeSec: 0 });
    const el = await h.startPlaying(tracks(3));
    el.emit("timeupdate", { currentTime: 70 });
    await flush();
    expect(h.transitionInfo().phase).toBe("preloading");
    h.state().showAirPlayPicker();
    expect(h.transitionInfo().phase).toBe("idle"); // the picker routes this element only
    el.emit("timeupdate", { currentTime: 75 });
    await flush();
    expect(h.transitionInfo().phase).toBe("idle");

    vi.advanceTimersByTime(h.AIRPLAY_PICKER_HOLD_MS); // dismissed without a choice
    el.emit("timeupdate", { currentTime: 76 });
    await flush();
    expect(h.transitionInfo().phase).toBe("preloading");
  });
});

describe("the AirPlay button", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    FakeAudio.airPlay = true;
    useFakeTimers();
    h = await boot();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const { AirPlayButton } = await import("../src/components/PlayerBar");
    act(() => root.render(createElement(AirPlayButton)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = () => host.querySelector<HTMLButtonElement>("button[aria-label='AirPlay']");

  it("appears only while targets are available, and opens the picker", async () => {
    expect(button()).toBeNull();
    const el = await act(() => h.startPlaying(tracks(2)));
    act(() => el.targets(true));
    expect(button()).not.toBeNull();
    expect(button()!.disabled).toBe(false);
    act(() => button()!.click());
    expect(el.calls.picker).toBe(1);
    act(() => el.targets(false));
    expect(button()).toBeNull();
  });

  it("shows a quiet note while playing on AirPlay", async () => {
    const el = await act(() => h.startPlaying(tracks(2)));
    act(() => el.targets(true));
    expect(host.textContent).not.toContain("Playing on AirPlay");
    act(() => el.wireless(true));
    expect(host.textContent).toContain("Playing on AirPlay");
    expect(button()!.className).toContain("on");
  });
});
