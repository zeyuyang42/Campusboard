import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NoteEditor, NOTE_SAVE_DELAY_MS, StarRating } from "../src/components/AlbumNotes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const area = () => host.querySelector("textarea")!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area(), text);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

describe("the note editor (#73)", () => {
  it("saves once typing pauses, not on every key", async () => {
    const onSave = vi.fn(async (_: string) => undefined);
    render(createElement(NoteEditor, { initial: "", onSave }));
    expect(area().classList.contains("selectable")).toBe(true);
    type("G");
    type("Go");
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS - 1));
    expect(onSave).not.toHaveBeenCalled();
    type("Good");
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS));
    expect(onSave.mock.calls).toEqual([["Good"]]);
  });

  it("saves at once on blur, and not again for the same text", async () => {
    const onSave = vi.fn(async (_: string) => undefined);
    render(createElement(NoteEditor, { initial: "old", onSave }));
    act(() => area().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onSave).not.toHaveBeenCalled(); // unchanged
    type("new");
    act(() => area().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onSave.mock.calls).toEqual([["new"]]);
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS * 2));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("saves what was typed when the page goes away", () => {
    const onSave = vi.fn(async (_: string) => undefined);
    render(createElement(NoteEditor, { initial: "", onSave }));
    type("half a thought");
    act(() => root.unmount());
    expect(onSave.mock.calls).toEqual([["half a thought"]]);
    root = createRoot(host); // for afterEach
  });

  it("shows a failed save and tries again on the next blur", async () => {
    const onSave = vi.fn(async (_: string): Promise<void> => { throw new Error("disk full"); });
    render(createElement(NoteEditor, { initial: "", onSave }));
    type("x");
    act(() => area().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await flush();
    expect(host.textContent).toContain("Couldn't save your note");
    onSave.mockImplementation(async () => undefined);
    act(() => area().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await flush();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("Couldn't save");
  });

  it("caps the note at 2000 characters", () => {
    render(createElement(NoteEditor, { initial: "", onSave: async () => undefined }));
    expect(area().maxLength).toBe(2000);
  });
});

describe("the star rating (#73)", () => {
  it("is a keyboard slider: arrows step, digits set, 0 clears, and the player's shortcuts don't see the keys", () => {
    const onChange = vi.fn();
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      render(createElement(StarRating, { value: 3, onChange }));
      const s = host.querySelector<HTMLElement>("[role=slider]")!;
      expect(s.tabIndex).toBe(0);
      expect(s.getAttribute("aria-valuetext")).toBe("3 of 5 stars");
      const key = (k: string) => act(() => s.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
      key("ArrowRight"); key("ArrowLeft"); key("5"); key("0"); key("Delete");
      expect(onChange.mock.calls).toEqual([[4], [2], [5], [0], [0]]);
      expect(shortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("a click sets the rating and a click on the current one clears it", () => {
    const onChange = vi.fn();
    render(createElement(StarRating, { value: 2, onChange }));
    const stars = host.querySelectorAll<HTMLElement>(".star");
    act(() => stars[3].click());
    act(() => stars[1].click());
    expect(onChange.mock.calls).toEqual([[4], [0]]);
    // Rated and unrated stars differ by shape, not only by colour.
    expect(Array.from(stars).map((x) => x.textContent).join("")).toBe("★★☆☆☆");
  });
});

describe("the album page's notes with the query cache (#81 review)", () => {
  type Note = { rating: number; note: string; updated_at: string };
  async function setup() {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { AlbumNotes } = await import("../src/components/AlbumNotes");
    const rows = new Map<number, Note>();
    const log: string[] = [];
    let gate: Promise<void> | null = null;
    const write = async (id: number, p: Partial<Note>, what: string) => {
      log.push(`start ${what}`);
      if (gate) await gate;
      rows.set(id, { rating: 0, note: "", updated_at: "x", ...rows.get(id), ...p });
      log.push(`end ${what}`);
    };
    const core = {
      albumNote: vi.fn(async (id: number) => rows.get(id) ?? null),
      setAlbumNote: vi.fn((id: number, note: string) => write(id, { note }, `note ${note}`)),
      setAlbumRating: vi.fn((id: number, rating: number) => write(id, { rating }, `rating ${rating}`)),
    };
    Object.assign(globalThis, { __fakeCore: core });
    // The app's defaults (main.tsx): a cached note is served at once on return.
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });
    const show = (albumId: number) => render(createElement(QueryClientProvider, { client: qc }, createElement(AlbumNotes, { key: albumId, albumId })));
    const settle = () => act(async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); if (i % 3 === 0) vi.advanceTimersByTime(1); } });
    const hold = () => { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; };
    return { rows, core, log, show, settle, qc, hold };
  }

  it("a note typed just before switching albums is there on return, and the next edit builds on it", async () => {
    const t = await setup();
    t.rows.set(1, { rating: 0, note: "old", updated_at: "x" });
    t.show(1); await t.settle();
    expect(area().value).toBe("old");
    type("typed note");
    t.show(2); await t.settle(); // leaving album 1 saves it
    expect(t.rows.get(1)?.note).toBe("typed note");
    t.show(1); await t.settle();
    expect(area().value).toBe("typed note");
    type("typed note, and more");
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS));
    await t.settle();
    expect(t.rows.get(1)?.note).toBe("typed note, and more");
  });

  const refetch = (t: Awaited<ReturnType<typeof setup>>) => act(async () => { await t.qc.invalidateQueries({ queryKey: ["album", 1, "note"] }); });

  it("takes fresher data when nothing typed is unsaved, never over unsaved edits", async () => {
    const t = await setup();
    t.show(1); await t.settle();
    t.rows.set(1, { rating: 3, note: "from an import", updated_at: "y" });
    await refetch(t); await t.settle();
    expect(area().value).toBe("from an import");
    expect(host.querySelector("[role=slider]")!.getAttribute("aria-valuenow")).toBe("3");
    type("mine, not saved yet");
    t.rows.set(1, { rating: 3, note: "another", updated_at: "z" });
    await refetch(t); await t.settle();
    expect(area().value).toBe("mine, not saved yet");
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS));
    await t.settle();
    expect(t.rows.get(1)?.note).toBe("mine, not saved yet");
  });

  it("focused but unedited: newer data is adopted, so the next keystroke builds on it", async () => {
    const t = await setup();
    t.rows.set(1, { rating: 0, note: "stale", updated_at: "x" });
    t.show(1); await t.settle();
    area().focus();
    act(() => area().dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    t.rows.set(1, { rating: 0, note: "newer", updated_at: "y" });
    await refetch(t); await t.settle();
    expect(area().value).toBe("newer");
    type(area().value + "!");
    act(() => vi.advanceTimersByTime(NOTE_SAVE_DELAY_MS));
    await t.settle();
    expect(t.rows.get(1)?.note).toBe("newer!");
  });

  it("data that lands while a save is on its way waits for that save", async () => {
    const t = await setup();
    t.rows.set(1, { rating: 0, note: "a", updated_at: "x" });
    t.show(1); await t.settle();
    const open = t.hold();
    type("ab");
    act(() => area().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    // A refetch begun before the write lands answers with the old note: not taken.
    await refetch(t); await t.settle();
    expect(area().value).toBe("ab");
    open();
    await t.settle();
    expect(area().value).toBe("ab");
    expect(t.rows.get(1)?.note).toBe("ab");
  });

  it("writes of one album run one after another, in order", async () => {
    const t = await setup();
    t.show(1); await t.settle();
    const open = t.hold();
    const s = host.querySelector<HTMLElement>("[role=slider]")!;
    const key = (k: string) => act(() => { s.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
    key("ArrowRight"); key("ArrowRight"); key("ArrowRight");
    expect(s.getAttribute("aria-valuenow")).toBe("3"); // shown at once from the cache
    await t.settle();
    expect(t.log).toEqual(["start rating 1"]);
    open();
    await t.settle();
    expect(t.log).toEqual(["start rating 1", "end rating 1", "start rating 2", "end rating 2", "start rating 3", "end rating 3"]);
    expect(t.rows.get(1)?.rating).toBe(3);
  });

  it("a failed rating save puts the stars back and says so", async () => {
    const t = await setup();
    t.rows.set(1, { rating: 2, note: "", updated_at: "x" });
    t.core.setAlbumRating.mockImplementation(async () => { throw new Error("database is locked"); });
    t.show(1); await t.settle();
    act(() => host.querySelectorAll<HTMLElement>(".star")[4].click());
    await t.settle();
    expect(host.querySelector("[role=slider]")!.getAttribute("aria-valuenow")).toBe("2");
    expect(host.textContent).toContain("Couldn't save the rating");
  });
});
