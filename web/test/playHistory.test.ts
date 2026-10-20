import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { HistoryCursor, HistoryEntry } from "@bc/core";
import { groupByDay } from "../src/lib/history";
import { PlayHistory } from "../src/components/PlayHistory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A local wall-clock moment as plays.played_at stores it (UTC), so the tests hold in any timezone. */
const stored = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
let seq = 0;
const entry = (when: Date, title = `Track ${++seq}`): HistoryEntry => ({
  id: seq, play_id: seq, played_at: stored(when), track_id: seq, album_id: 1, title, track_num: 1, duration: 200,
  track_artist: null, streamable: true, lyrics: null, album_title: "Album", artist_name: "Artist", art_id: null,
});

describe("groupByDay (#86)", () => {
  // Wednesday 14 October 2026, 00:30 local: just after midnight, where UTC and local days differ most.
  const now = new Date(2026, 9, 14, 0, 30);

  it("labels local days Today, Yesterday, then dates, keeping plays newest first", () => {
    const es = [
      entry(new Date(2026, 9, 14, 0, 10)),
      entry(new Date(2026, 9, 13, 23, 59)),
      entry(new Date(2026, 9, 13, 0, 0)),
      entry(new Date(2026, 9, 12, 23, 59, 59)),
      entry(new Date(2025, 11, 31, 22, 0)),
    ];
    const days = groupByDay(es, now, "en-US");
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday", "Monday, October 12", "Wednesday, December 31, 2025"]);
    expect(days.map((d) => d.entries.map((e) => e.play_id))).toEqual([[es[0].play_id], [es[1].play_id, es[2].play_id], [es[3].play_id], [es[4].play_id]]);
  });

  it("finds yesterday across a month boundary", () => {
    const first = new Date(2026, 10, 1, 9, 0);
    expect(groupByDay([entry(new Date(2026, 9, 31, 20, 0))], first, "en-US")[0].label).toBe("Yesterday");
  });

  it("is empty for no plays", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe("the History tab (#86)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let all: HistoryEntry[];
  const core = {
    history: vi.fn(async (before: HistoryCursor | null, limit: number) => {
      const start = before ? all.findIndex((e) => e.play_id === before.id) + 1 : 0;
      const entries = all.slice(start, start + limit);
      const last = entries[entries.length - 1];
      return { entries, next: start + limit < all.length && last ? { played_at: last.played_at, id: last.play_id } : null };
    }),
    getSetting: vi.fn(async () => null),
  };

  beforeEach(() => {
    (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
    core.history.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(PlayHistory)))));
  };
  async function flush() {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  const rows = () => host.querySelectorAll(".history li").length;
  const more = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Show more");

  it("loads 50 plays at a time with Show more, then hides it at the end", async () => {
    const t0 = Date.now();
    all = Array.from({ length: 120 }, (_, i) => entry(new Date(t0 - i * 60_000)));
    render();
    await flush();
    expect(rows()).toBe(50);
    expect(core.history).toHaveBeenLastCalledWith(null, 50);
    act(() => more()!.click());
    await flush();
    expect(rows()).toBe(100);
    expect(core.history).toHaveBeenLastCalledWith({ played_at: all[49].played_at, id: all[49].play_id }, 50);
    act(() => more()!.click());
    await flush();
    expect(rows()).toBe(120);
    expect(more()).toBeUndefined();
    // Each row: track, artist, album and time.
    const first = host.querySelector(".history li")!;
    expect(first.querySelector(".title")!.textContent).toBe(all[0].title);
    expect(first.querySelector(".sub")!.textContent).toBe("Artist");
    expect(first.querySelector("a.album")!.getAttribute("href")).toBe("/album/1");
    expect(first.querySelector("time")!.textContent).not.toBe("");
  });

  it("shows an empty state", async () => {
    all = [];
    render();
    await flush();
    expect(host.querySelector(".empty")!.textContent).toContain("Nothing played yet");
    expect(more()).toBeUndefined();
  });
});
