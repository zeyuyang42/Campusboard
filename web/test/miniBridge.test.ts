import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINI_EVENTS } from "@bc/core";
import { boot, track, useFakeTimers, type Harness } from "./harness";

// The bus to the mini window: the test plays the mini window's side.
vi.mock("../src/mini/bus", () => ({
  createBus: async () => (globalThis as { __fakeBus?: unknown }).__fakeBus,
}));

function makeBus() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    send: vi.fn(async (_event: string, _payload: unknown) => undefined),
    on: vi.fn(async (event: string, cb: (payload: unknown) => void) => { handlers.set(event, cb); return () => undefined; }),
  };
}

let h: Harness;
let bus: ReturnType<typeof makeBus>;
let bridge: typeof import("../src/player/miniBridge");
const command = (payload: unknown) => bus.handlers.get(MINI_EVENTS.command)!(payload);
const stateSends = () => bus.send.mock.calls.filter(([e]) => e === MINI_EVENTS.state);

beforeEach(async () => {
  useFakeTimers();
  h = await boot();
  bus = makeBus();
  Object.assign(globalThis, { __fakeBus: bus });
  bridge = await import("../src/player/miniBridge");
  await bridge.initMiniBridge();
});
afterEach(() => { vi.useRealTimers(); });

describe("hello / bye", () => {
  it("sends nothing until hello, the full state at hello, and stops at bye", () => {
    h.state().setVolume(0.5);
    h.state().cycleRepeat();
    expect(stateSends()).toHaveLength(0);

    command({ type: "hello" });
    expect(bridge.miniBridgeInfo()).toMatchObject({ live: true, hellos: 1 });
    expect(stateSends()).toHaveLength(1);
    expect(stateSends()[0][1]).toMatchObject({ track: null, status: "idle" });

    h.state().hydrate({ queue: [h.toQueueTrack(track({ title: "Song" }))], index: 0, position: 3, volume: 1, shuffle: false, repeat: "off" });
    expect(stateSends().length).toBeGreaterThan(1);
    expect(stateSends().at(-1)![1]).toMatchObject({ track: { title: "Song" }, status: "paused" });

    command({ type: "bye" });
    expect(bridge.miniBridgeInfo()).toMatchObject({ live: false, byes: 1 });
    const n = stateSends().length;
    h.state().cycleRepeat();
    h.state().seek(10);
    expect(stateSends()).toHaveLength(n);
  });

  it("a second hello sends the full state again even if nothing changed", () => {
    command({ type: "hello" });
    command({ type: "hello" });
    expect(stateSends()).toHaveLength(2);
  });
});

describe("command validation", () => {
  it.each([
    null, undefined, 1, "toggle", [], {}, { type: 1 }, { type: "rm -rf" }, { type: "__proto__" },
    { type: "seek" }, { type: "seek", sec: -1 }, { type: "seek", sec: "5" }, { type: "seek", sec: Number.NaN }, { type: "seek", sec: Infinity },
  ])("rejects %j", (payload) => {
    const actions = spyActions();
    command(payload);
    expect(bridge.miniBridgeInfo()).toMatchObject({ rejected: 1, commands: 0 });
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it("clamps a seek far past any track", () => {
    const { seek } = spyActions();
    command({ type: "seek", sec: 1e12 });
    expect(seek).toHaveBeenCalledWith(24 * 3600);
  });
});

/** Replace the store's actions with spies; the queue gets one track so seek applies. */
function spyActions() {
  const actions = { play: vi.fn(), pause: vi.fn(), toggle: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn() };
  h.usePlayer.setState({ ...actions, queue: [h.toQueueTrack(track())], index: 0 });
  return actions;
}

describe("commands map to store actions", () => {
  it.each([
    ["play", "play"], ["pause", "pause"], ["toggle", "toggle"], ["next", "next"], ["prev", "prev"],
  ] as const)("%s -> %s()", (type, action) => {
    const actions = spyActions();
    command({ type, extra: "dropped" });
    expect(actions[action]).toHaveBeenCalledTimes(1);
    for (const [k, fn] of Object.entries(actions)) if (k !== action) expect(fn).not.toHaveBeenCalled();
    expect(bridge.miniBridgeInfo()).toMatchObject({ commands: 1, lastCommand: type });
  });

  it("seek goes to the store only when there is a current track", () => {
    const { seek } = spyActions();
    command({ type: "seek", sec: 30 });
    expect(seek).toHaveBeenCalledWith(30);
    h.usePlayer.setState({ queue: [] });
    command({ type: "seek", sec: 40 });
    expect(seek).toHaveBeenCalledTimes(1);
  });

  it("toggle while buffering pauses, and records what it saw", async () => {
    const el = await h.startPlaying([track(), track()]);
    el.emit("waiting");
    command({ type: "toggle" });
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
    expect(bridge.miniBridgeInfo().lastToggle).toEqual({
      before: { status: "loading", wantsPlay: true, paused: false },
      decision: "pause",
      after: { status: "paused", wantsPlay: false, paused: true },
    });
  });

  it("showMain focuses this window outside Tauri", () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    command({ type: "showMain" });
    expect(focus).toHaveBeenCalled();
  });
});

describe("the sleep timer (#70)", () => {
  it("adds nothing to the mini window: its countdown sends no state", () => {
    h.state().hydrate({ queue: [h.toQueueTrack(track({ title: "Song" }))], index: 0, position: 3, volume: 1, shuffle: false, repeat: "off" });
    command({ type: "hello" });
    const n = stateSends().length;
    h.state().setSleep(15);
    vi.advanceTimersByTime(5000);
    expect(h.state().sleepLeft).toBe(895);
    expect(stateSends()).toHaveLength(n);
    expect(JSON.stringify(stateSends().at(-1)![1])).not.toMatch(/sleep/i);
    h.state().setSleep("off");
  });
});
