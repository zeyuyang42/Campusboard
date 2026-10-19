import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";

const invoke = vi.fn(async (_cmd: string, _args: unknown) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));

let h: Harness;
let menuBar: typeof import("../src/lib/menuBar");
const calls = () => invoke.mock.calls.map(([, args]) => args);

beforeEach(async () => {
  useFakeTimers();
  invoke.mockClear();
  // env.ts decides isTauri when it is first imported.
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  h = await boot();
  menuBar = await import("../src/lib/menuBar");
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("menu bar icon", () => {
  it("stays off by default and never calls Rust while off", async () => {
    await menuBar.initMenuBar();
    await h.startPlaying([track({ title: "One" }), track({ title: "Two" })]);
    h.state().next();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("restores a saved setting and sends the title only when the track changes", async () => {
    h.core.settings.set(menuBar.MENU_BAR_SETTING_KEY, true);
    await menuBar.initMenuBar();
    expect(calls()).toEqual([{ enabled: true, track: null }]);

    await h.startPlaying([track({ title: "One" }), track({ title: "Two" })]);
    h.state().seek(30);
    h.state().setVolume(0.4);
    expect(calls()).toEqual([{ enabled: true, track: null }, { enabled: true, track: "One" }]);

    h.state().next();
    await flush();
    expect(calls().at(-1)).toEqual({ enabled: true, track: "Two" });
    expect(calls()).toHaveLength(3);
  });

  it("the selftest's resend repeats the last state instead of removing the icon", async () => {
    h.core.settings.set(menuBar.MENU_BAR_SETTING_KEY, true);
    await menuBar.initMenuBar();
    await h.startPlaying([track({ title: "One" })]);
    await menuBar.resendMenuBar();
    expect(calls().at(-1)).toEqual({ enabled: true, track: "One" });
  });

  it("the toggle creates and removes the icon and is persisted", async () => {
    await menuBar.initMenuBar();
    await h.startPlaying([track({ title: "One" })]);
    menuBar.useMenuBar.getState().setEnabled(true);
    await flush();
    expect(calls()).toEqual([{ enabled: true, track: "One" }]);
    expect(h.core.settings.get(menuBar.MENU_BAR_SETTING_KEY)).toBe(true);

    menuBar.useMenuBar.getState().setEnabled(false);
    await flush();
    expect(calls().at(-1)).toEqual({ enabled: false, track: null });
    expect(h.core.settings.get(menuBar.MENU_BAR_SETTING_KEY)).toBe(false);
  });
});
