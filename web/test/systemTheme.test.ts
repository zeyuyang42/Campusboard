import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINI_EVENTS, PRESETS, type Theme } from "@bc/core";
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
  // Node 25 has its own half-working localStorage global; give each test a clean one.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
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

/** Quit and launch again on the same database: fresh modules, same settings and play count. */
async function relaunch(plays: number) {
  const settings = new Map(h.core.settings);
  h = await boot();
  for (const [k, v] of settings) h.core.settings.set(k, v);
  h.core.playCount.mockResolvedValue(plays);
  theme = await import("../src/theme/store");
  document.documentElement.removeAttribute("style");
}
const savedTheme = () => (h.core.settings.get("theme") as { theme: Theme } | undefined)?.theme;

describe("the default theme", () => {
  it("is System for a new library, saved at once so it survives the first plays", async () => {
    theme.watchSystemAppearance(fakeMedia(false).win);
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme.mode).toBe("system");
    expect(theme.useTheme.getState().resolved.palette).toEqual(daylight.palette);
    expect(savedTheme()?.mode).toBe("system"); // written without waiting for the save timer

    // Play something, quit, launch again: still following the system.
    await relaunch(1);
    await theme.initTheme();
    expect(theme.useTheme.getState().theme.mode).toBe("system");
    expect(savedTheme()?.mode).toBe("system");
  });

  it("a fresh install importing a library with history but no theme keeps Match system", async () => {
    await theme.loadSavedTheme(); // first launch
    // What importLibrary leaves for settings.theme: null with history: plays, theme untouched.
    h.core.playCount.mockResolvedValue(40);
    await theme.loadSavedTheme(); // LibrarySettings calls this after the import
    expect(theme.useTheme.getState().theme.mode).toBe("system");
  });

  it("an existing library keeps its saved theme, or the old fixed default if it never saved one", async () => {
    theme.watchSystemAppearance(fakeMedia(false).win);
    h.core.settings.set("theme", { theme: daylight, basePreset: daylight.name });
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme).toEqual(daylight);

    h.core.settings.delete("theme");
    h.core.playCount.mockResolvedValue(12);
    await theme.loadSavedTheme();
    expect(theme.useTheme.getState().theme).toEqual(dusk);
    expect(css("--surface")).toBe(dusk.palette.surface);
    expect(savedTheme()).toEqual(dusk);
  });
});

describe("the first paint", () => {
  it("a slow early-paint background never overrides the saved theme's", async () => {
    // The remembered theme has a file background that resolves late; the saved one has none.
    const slow = { ...dusk, background: { source: "file" as const, value: "old.jpg", blur: 0, dim: 0 } };
    localStorage.setItem("bc.theme.last", JSON.stringify(slow));
    let release!: () => void;
    const files = await import("../src/lib/files");
    vi.spyOn(files, "backgroundFileUrl").mockImplementation(() => new Promise((r) => { release = () => r("asset://old.jpg"); }));
    h.core.settings.set("theme", { theme: dusk, basePreset: dusk.name });
    await theme.initTheme();
    expect(css("--bg-image")).toBe("none");
    release();
    await flush();
    expect(css("--bg-image")).toBe("none");
  });

  it("shows the theme last used in this window before the database answers", async () => {
    theme.useTheme.getState().replace(dusk, dusk.name); // a pinned dark theme, on a light Mac
    await relaunch(3);
    let answer!: (v: { theme: Theme; basePreset: string }) => void;
    h.core.getSetting.mockImplementationOnce(() => new Promise<unknown>((r) => { answer = r; }) as Promise<null>);
    const started = theme.initTheme();
    expect(css("--surface")).toBe(dusk.palette.surface); // not the default's light side
    await flush();
    expect(css("--surface")).toBe(dusk.palette.surface);
    answer({ theme: dusk, basePreset: dusk.name });
    await started;
    expect(css("--surface")).toBe(dusk.palette.surface);
  });

  it("ignores a damaged remembered theme", async () => {
    localStorage.setItem("bc.theme.last", JSON.stringify({ ...dusk, palette: { ...dusk.palette, surface: "red;x" } }));
    const started = theme.initTheme();
    expect(css("--surface")).toBe(theme.useTheme.getState().resolved.palette.surface);
    await started;
  });
});
