import { describe, it, expect } from "vitest";
import { audioEventPatch, swappingAfter } from "../src/services/audioEvents.js";
import { toggleAction } from "../src/services/playerToggle.js";

const el = (paused: boolean, o: { ended?: boolean; internal?: boolean } = {}) => ({ paused, ended: o.ended ?? false, internal: o.internal ?? false });

describe("audio events (#55)", () => {
  it("play/playing while the element plays: playing, with intent", () => {
    for (const t of ["play", "playing"] as const) expect(audioEventPatch(t, el(false))).toEqual({ status: "playing", wantsPlay: true, error: null });
  });
  it("a stale play/playing handled after a pause changes nothing", () => {
    for (const t of ["play", "playing"] as const) expect(audioEventPatch(t, el(true))).toBeNull();
  });
  it("waiting while playing is buffering; a stale one after a pause changes nothing", () => {
    expect(audioEventPatch("waiting", el(false))).toEqual({ status: "loading" });
    expect(audioEventPatch("waiting", el(true))).toBeNull();
  });
  it("a pause from outside the store ends the intent to play", () => {
    expect(audioEventPatch("pause", el(true))).toEqual({ status: "paused", wantsPlay: false });
  });
  it("the store's own pause while loading or switching tracks keeps the intent", () => {
    expect(audioEventPatch("pause", el(true, { internal: true }))).toEqual({ status: "paused" });
  });
  it("the pause before ended is left to the ended handler", () => {
    expect(audioEventPatch("pause", el(true, { ended: true }))).toBeNull();
  });

  it("replays the race from the issue: Pause, then a queued playing event", () => {
    // Playing, the listener presses Pause (the store clears wantsPlay and pauses the element),
    // then WebKit delivers a "playing" queued while the stream recovered from buffering.
    let state = { status: "playing" as const as string, wantsPlay: true };
    expect(toggleAction("playing", true)).toBe("pause");
    state = { status: "playing", wantsPlay: false }; // store.pause()
    const pausePatch = audioEventPatch("pause", el(true));
    state = { ...state, ...pausePatch };
    const stale = audioEventPatch("playing", el(true));
    if (stale) state = { ...state, ...stale };
    expect(state).toEqual({ status: "paused", wantsPlay: false });
  });

  it("a system pause leaves nothing to resume on the next load", () => {
    let state = { status: "playing", wantsPlay: true };
    state = { ...state, ...audioEventPatch("pause", el(true))! };
    expect(state.wantsPlay).toBe(false);
    expect(toggleAction(state.status as "paused", state.wantsPlay)).toBe("play");
  });
});

describe("the store's source-swap flag", () => {
  it("is set afresh by every load: only a playing element can send a swap pause", () => {
    expect(swappingAfter(false, { type: "load", paused: false })).toBe(true);
    expect(swappingAfter(true, { type: "load", paused: true })).toBe(false); // not left over from an earlier load
  });
  it("is cleared by the pause, the new track playing, an error or a refused play()", () => {
    for (const ev of [{ type: "pause" }, { type: "playing", paused: false }, { type: "error" }, { type: "playRejected" }] as const) {
      expect(swappingAfter(true, ev)).toBe(false);
    }
    expect(swappingAfter(true, { type: "playing", paused: true })).toBe(true); // a stale playing changes nothing
  });
  it("a load that fails to play can't make a later system pause look internal", () => {
    let swapping = swappingAfter(false, { type: "load", paused: false });
    swapping = swappingAfter(swapping, { type: "error" });
    expect(audioEventPatch("pause", { paused: true, ended: false, internal: swapping })).toEqual({ status: "paused", wantsPlay: false });
  });
});
