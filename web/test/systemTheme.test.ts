import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINI_EVENTS, PRESETS } from "@bc/core";
import { boot, flush, useFakeTimers, type Harness } from "./harness";

vi.mock("../src/mini/bus", () => ({
  createBus: async () => (globalThis as { __fakeBus?: unknown }).__fakeBus,
}));

/** A prefers-color-scheme media query whose answer the test flips, like a macOS appearance change. */
function fakeMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() { return dark; },
    addEventListener: vi.fn((_: string, cb: () => void) => { listeners.add(cb); }),
    removeEventListener: vi.fn((_: string, cb: () => void) => { listeners.delete(cb); }),
  };
  return {
    listeners,
    win: { matchMedia: vi.fn(() => mql as unknown as MediaQueryList) },
    set(next: boolean) { dark = next; listeners.forEach((cb) => cb()); },
  };
}

const css = (name: string) => document.documentElement.style.getPropertyValue(name);
const [dusk, daylight] = PRESETS;

let h: Harness;
let theme: typeof import("../src/theme/store");
beforeEach(async () => {
  useFakeTimers();
  h = await boot(); // resets modules: a fresh theme store per test
  theme = await import("../src/theme/store");
  document.documentElement.removeAttribute("style");
});
afterEach(() => { vi.useRealTimers(); });

describe("following the system appearance", () => {
  it("repaints :root live when the appearance changes, without a reload", async () => {
    const media = fakeMedia(true);
    const stop = theme.watchSystemAppearance(media.win);
    theme.useTheme.getState().replace({ ...dusk, mode: "system" }, dusk.name);
    expect(css("--surface")).toBe(dusk.paletteDark!.surface);
    expect(css("--color-scheme")).toBe("dark");

    media.set(false);
    expect(theme.useTheme.getState().resolved.mode).toBe("light");
    expect(css("--surface")).toBe(dusk.paletteLight!.surface);
    expect(css("--color-scheme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    media.set(true);
    expect(css("--surface")).toBe(dusk.paletteDark!.surface);

    stop();
    expect(media.listeners.size).toBe(0);
    media.set(false);
    expect(css("--surface")).toBe(dusk.paletteDark!.surface);
  });

  it("an explicit dark or light theme ignores appearance changes", () => {
    const media = fakeMedia(false);
    theme.watchSystemAppearance(media.win);
    theme.useTheme.getState().replace(dusk, dusk.name);
    expect(css("--surface")).toBe(dusk.palette.surface);
    media.set(true);
    media.set(false);
    expect(css("--surface")).toBe(dusk.palette.surface);
    expect(theme.useTheme.getState().resolved.mode).toBe("dark");
  });

  it("switching Base to Match system takes the side for the current appearance; presets keep following", () => {
    const media = fakeMedia(false);
    theme.watchSystemAppearance(media.win);
    theme.useTheme.getState().replace(dusk, dusk.name);
    theme.useTheme.getState().update({ mode: "system" });
    expect(css("--surface")).toBe(daylight.palette.surface);
    theme.useTheme.getState().applyPreset("High contrast");
    expect(theme.useTheme.getState().theme.mode).toBe("system");
    expect(css("--surface")).toBe("#FFFFFF");
    media.set(true);
    expect(css("--surface")).toBe("#000000");
  });

  it("sends the mini player the theme settled for the new appearance", async () => {
    const bus = { handlers: new Map<string, (p: unknown) => void>(), send: vi.fn(async (_e: string, _p: unknown) => undefined),
      on: vi.fn(async (e: string, cb: (p: unknown) => void) => { bus.handlers.set(e, cb); return () => undefined; }) };
    Object.assign(globalThis, { __fakeBus: bus });
    const media = fakeMedia(true);
    theme.watchSystemAppearance(media.win);
    theme.useTheme.getState().replace({ ...dusk, mode: "system" }, dusk.name);
    const bridge = await import("../src/player/miniBridge");
    await bridge.initMiniBridge();
    bus.handlers.get(MINI_EVENTS.command)!({ type: "hello" });
    const lastTheme = () => (bus.send.mock.calls.filter(([e]) => e === MINI_EVENTS.state).at(-1)![1] as { theme: { mode: string; palette: { surface: string } } }).theme;
    expect(lastTheme()).toMatchObject({ mode: "dark", palette: { surface: dusk.paletteDark!.surface } });
    media.set(false);
    expect(lastTheme()).toMatchObject({ mode: "light", palette: { surface: dusk.paletteLight!.surface } });
  });
});

describe("the default theme", () => {
  it("is System for a new library", async () => {
    theme.watchSystemAppearance(fakeMedia(false).win);
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme.mode).toBe("system");
    expect(theme.useTheme.getState().resolved.palette).toEqual(daylight.palette);
  });

  it("an existing library keeps its saved theme, or the old fixed default if it never saved one", async () => {
    theme.watchSystemAppearance(fakeMedia(false).win);
    h.core.settings.set("theme", { theme: daylight, basePreset: daylight.name });
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme).toEqual(daylight);

    h.core.settings.delete("theme");
    Object.assign(h.core, { playCount: vi.fn(async () => 12) });
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme).toEqual(dusk);
    expect(css("--surface")).toBe(dusk.palette.surface);
    vi.advanceTimersByTime(400);
    await flush();
    expect((h.core.settings.get("theme") as { theme: unknown }).theme).toEqual(dusk);
  });
});
