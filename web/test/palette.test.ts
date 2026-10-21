import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@bc/core";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";

// usePalette (#110): one art change asks core for the swatches first (a miss fetches the
// image once and fills both caches) and only then for the palette, so a new art id never
// costs two image requests. The fake core records the call order.

let h: Harness;
let calls: string[];
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
  calls = [];
  const swatchesFn = h.core.getArtSwatches as unknown as ReturnType<typeof vi.fn>;
  const paletteFn = h.core.getArtPalette as unknown as ReturnType<typeof vi.fn>;
  swatchesFn.mockImplementation(async () => { calls.push("swatches"); await Promise.resolve(); calls.push("swatches-done"); return { version: 1, swatches: [{ hex: "#c8321e", weight: 0.7 }, { hex: "#1f3f8a", weight: 0.3 }] }; });
  paletteFn.mockImplementation(async () => { calls.push("palette"); return { accent: "#c8321e", ambient1: "#884433", ambient2: "#334488" }; });
  const { initPalette } = await import("../src/theme/usePalette");
  initPalette();
});
afterEach(() => { vi.useRealTimers(); });

describe("usePalette", () => {
  it("asks for the swatches first and the palette after they settled, once per art id", async () => {
    h.state().playTracks([track({ art_id: 42 }), track({ art_id: 42 })], 0);
    await flush();
    expect(calls).toEqual(["swatches", "swatches-done", "palette"]);
    expect(h.core.getArtSwatches).toHaveBeenCalledTimes(1);
    expect(h.core.getArtSwatches).toHaveBeenCalledWith({ artId: 42 });
    expect(h.core.getArtPalette).toHaveBeenCalledTimes(1);
    // The next track has the same art: nothing is asked again.
    h.state().next();
    await flush();
    expect(h.core.getArtSwatches).toHaveBeenCalledTimes(1);
    expect(h.core.getArtPalette).toHaveBeenCalledTimes(1);
    const { currentSwatches, currentSwatchKey } = await import("../src/backdrop/swatches");
    expect(currentSwatchKey()).toBe(42);
    expect(currentSwatches()?.swatches).toHaveLength(2);
    expect(document.documentElement.style.getPropertyValue("--ambient-1")).toBe(currentSwatches()!.swatches[0].hex);
  });

  it("a radio episode is keyed by its image id (negative) and never asks for a palette", async () => {
    const episode = { ...track({ art_id: null }), radio: { show_id: 7, image_id: 1234, program: "Weekly" } } as unknown as Track;
    h.state().playTracks([episode], 0);
    await flush();
    expect(h.core.getArtSwatches).toHaveBeenCalledWith({ imageId: 1234 });
    expect(h.core.getArtPalette).not.toHaveBeenCalled();
    const { currentSwatchKey } = await import("../src/backdrop/swatches");
    expect(currentSwatchKey()).toBe(-1234);
  });
});
