import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Crate } from "@bc/core";
import { MenuHost } from "../src/components/MenuHost";
import { useMenu } from "../src/ui/menu";
import { flushAct as flush } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const crate = (id: number, name: string): Crate => ({ id, name, created_at: "", updated_at: "", album_count: 0, art_ids: [] });
/** crate id -> the album ids in it, the picker's marks come from here. */
let members: Map<number, Set<number>>;
let crates: Crate[];
const core = {
  crates: vi.fn(async () => crates),
  cratesContaining: vi.fn(async (albumIds: number[]) => new Map([...members].map(([id, s]) => [id, albumIds.filter((a) => s.has(a)).length] as const).filter(([, n]) => n > 0))),
  addToCrate: vi.fn(async (id: number, albumIds: number[]) => { for (const a of albumIds) members.get(id)!.add(a); return albumIds.length; }),
  removeFromCrate: vi.fn(async (id: number, albumIds: number[]) => { for (const a of albumIds) members.get(id)!.delete(a); return albumIds.length; }),
  createCrate: vi.fn(async (name: string) => { const c = crate(crates.length + 1, name); crates = [...crates, c]; members.set(c.id, new Set()); return c; }),
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
  for (const f of Object.values(core)) f.mockClear();
  crates = [crate(1, "Late nights"), crate(2, "Running")];
  members = new Map([[1, new Set([10])], [2, new Set()]]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(h(QueryClientProvider, { client: qc }, h(MenuHost))));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const menu = () => document.querySelector("[role=menu]");
const rows = () => [...document.querySelectorAll<HTMLButtonElement>("[role=menu] [role=menuitem]")];
const row = (name: string) => rows().find((b) => b.textContent?.includes(name))!;
const mark = (name: string) => row(name).querySelector("span")!.textContent;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await flush(); };
const open = async (albumIds: number[]) => { act(() => useMenu.getState().show({ x: 10, y: 10 }, { cratePicker: { albumIds } })); await flush(); };

describe("the crate picker (#126)", () => {
  it("marks each crate by how many of the albums it holds", async () => {
    await open([10, 11]);
    expect(document.querySelector("[role=menu] .label")?.textContent).toBe("Add 2 albums to crate");
    expect(mark("Late nights")).toBe("–"); // one of the two
    expect(mark("Running")).toBe("");
    await open([10]);
    expect(document.querySelector("[role=menu] .label")?.textContent).toBe("Add to crate");
    expect(mark("Late nights")).toBe("✓");
  });

  it("a click adds the albums, keeps the menu open and shows the mark; a second click takes them out", async () => {
    await open([10, 11]);
    await click(row("Running"));
    expect(core.addToCrate).toHaveBeenCalledWith(2, [10, 11]);
    expect(menu()).not.toBeNull();
    expect(mark("Running")).toBe("✓");
    await click(row("Running"));
    expect(core.removeFromCrate).toHaveBeenCalledWith(2, [10, 11]);
    expect(menu()).not.toBeNull();
    expect(mark("Running")).toBe("");
    // Some in: a click adds the rest rather than removing.
    await click(row("Late nights"));
    expect(core.addToCrate).toHaveBeenLastCalledWith(1, [10, 11]);
    expect(mark("Late nights")).toBe("✓");
  });

  it("New crate… creates one, adds the albums and closes", async () => {
    await open([10]);
    await click(row("New crate…"));
    const input = document.querySelector<HTMLInputElement>("[role=menu] input")!;
    expect(input.placeholder).toBe("New crate name");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  Bought on tour ");
    await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(core.createCrate).toHaveBeenCalledWith("Bought on tour");
    expect(core.addToCrate).toHaveBeenCalledWith(3, [10]);
    expect(menu()).toBeNull();
  });
});
