import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { LibraryTags } from "../src/pages/LibraryPage";
import { flushAct as flush } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let view: { sort: string; filter: string };
const core = {
  getSetting: vi.fn(async (key: string) => (key === "library_view" ? view : null)),
  setSetting: vi.fn(async (_key: string, v: unknown) => { view = v as typeof view; }),
  tags: vi.fn(async (filter: string) => (filter === "purchased" ? [{ tag: "ambient", album_count: 1 }] : [{ tag: "ambient", album_count: 3 }, { tag: "rock", album_count: 2 }])),
};

beforeEach(() => {
  (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
  core.tags.mockClear();
  view = { sort: "added", filter: "purchased" };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

let qc: QueryClient;
const render = () => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); act(() => root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(LibraryTags))))); };
const rows = () => [...host.querySelectorAll(".tag-list a")].map((a) => a.textContent);

describe("the Tags tab (#71)", () => {
  it("counts under the Library's Show filter, like the grid it opens", async () => {
    render();
    await flush();
    expect(core.tags).toHaveBeenCalledWith("purchased");
    expect(rows()).toEqual(["ambient1"]);
    expect(host.textContent).toContain("Counting albums in your purchases");
    // "Count all albums" switches Show back to All, and the counts follow.
    act(() => host.querySelector<HTMLButtonElement>(".tag-scope button")!.click());
    await flush();
    expect(core.tags).toHaveBeenLastCalledWith("all");
    expect(rows()).toEqual(["ambient3", "rock2"]);
  });

  it("shows an error when the tags can't be read", async () => {
    view = { sort: "added", filter: "purchased" };
    core.tags.mockRejectedValueOnce(new Error("malformed"));
    render();
    await flush();
    expect(host.querySelector(".notice.error")?.textContent).toContain("Couldn't load your tags");
  });
});
