import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ListeningStats, StatsPeriod } from "@bc/core";
import { HistoryTab } from "../src/components/ListeningStats";
import { flushAct as flush } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY: ListeningStats = { totals: { plays: 0, seconds: 0, albums: 0 }, artists: [], albums: [], tags: [] };
const YEAR: ListeningStats = {
  totals: { plays: 7, seconds: 1500, albums: 2 },
  artists: [{ artist_id: 3, name: "Artist A", art_id: 11, plays: 7, seconds: 1500 }],
  albums: [
    { album_id: 5, title: "First", artist_name: "Artist A", art_id: 11, plays: 5, seconds: 1000 },
    { album_id: 6, title: "Second", artist_name: "Artist A", art_id: null, plays: 2, seconds: 500 },
  ],
  tags: [{ tag: "dub techno", art_id: 11, plays: 5, seconds: 1000 }],
};

let host: HTMLDivElement;
let root: Root;
let data: Record<StatsPeriod, ListeningStats>;
const core = {
  listeningStats: vi.fn(async (period: StatsPeriod) => data[period]),
  history: vi.fn(async () => ({ entries: [], next: null })),
  getSetting: vi.fn(async () => null),
};

beforeEach(() => {
  (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
  core.listeningStats.mockClear();
  core.history.mockClear();
  data = { month: EMPTY, year: YEAR, all: YEAR };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (url: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: [url] }, h(HistoryTab)))));
};
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
const select = () => host.querySelector<HTMLSelectElement>("select[aria-label=Period]");
const choose = (value: string) => act(() => {
  const s = select()!;
  s.value = value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
const links = (section: string) => [...host.querySelectorAll(`section[aria-label="${section}"] li a`)].map((a) => [a.textContent, a.getAttribute("href")]);

describe("Listening stats (#94)", () => {
  it("switches between the plays list and stats", async () => {
    render("/library/history");
    await flush();
    expect(core.history).toHaveBeenCalled();
    expect(core.listeningStats).not.toHaveBeenCalled();
    expect(select()).toBeNull();
    act(() => button("Stats").click());
    await flush();
    expect(core.listeningStats).toHaveBeenLastCalledWith("month");
    expect(button("Stats").getAttribute("aria-pressed")).toBe("true");
    act(() => button("List").click());
    await flush();
    expect(select()).toBeNull();
    expect(host.querySelector(".stats")).toBeNull();
  });

  it("shows a quiet empty state for a period without plays, and says radio isn't recorded", async () => {
    render("/library/history?view=stats");
    await flush();
    expect(host.querySelector(".empty")!.textContent).toContain("No plays this month yet.");
    expect(host.querySelectorAll(".stats li")).toHaveLength(0);
    expect(host.textContent).toContain("Radio episodes aren't recorded.");
  });

  it("loads the chosen period and links rows to the artist, album and tag", async () => {
    render("/library/history?view=stats");
    await flush();
    choose("year");
    await flush();
    expect(core.listeningStats).toHaveBeenLastCalledWith("year");
    expect(select()!.value).toBe("year");
    expect(host.querySelector(".stats-total")!.textContent).toBe("7 plays across 2 albums, 25 min listened.");
    expect(links("Top artists")).toEqual([["Artist A", "/artist/3"]]);
    expect(links("Top albums")).toEqual([["First", "/album/5"], ["Second", "/album/6"]]);
    expect(links("Top tags")).toEqual([["dub techno", "/library/albums?tag=dub%20techno"]]);
    const first = host.querySelector('section[aria-label="Top albums"] li')!;
    expect(first.querySelector(".n")!.textContent).toBe("5 plays17 min");
    expect(first.querySelector(".sub")!.textContent).toBe("Artist A");
    // Back to this month: empty again.
    choose("month");
    await flush();
    expect(core.listeningStats).toHaveBeenLastCalledWith("month");
    expect(host.querySelector(".empty")!.textContent).toContain("No plays this month yet.");
  });

  it("reads the period from the address", async () => {
    render("/library/history?view=stats&period=all");
    await flush();
    expect(core.listeningStats).toHaveBeenCalledWith("all");
    expect(core.listeningStats).not.toHaveBeenCalledWith("month");
    expect(select()!.value).toBe("all");
  });
});
