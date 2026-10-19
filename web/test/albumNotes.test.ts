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
  });
});
