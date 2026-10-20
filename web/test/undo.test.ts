import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { boot, flush, useFakeTimers, type Harness } from "./harness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hs: Harness;
let undo: typeof import("../src/ui/undo");
let removals: typeof import("../src/lib/removals");
let host: HTMLDivElement;
let root: Root;

/** The removal calls the Undo note makes, on top of the player's fake core. */
const extra = () => ({
  removeAlbumLater: vi.fn(async (_id: number) => true),
  undoRemoveAlbum: vi.fn(async (_id: number) => undefined),
  finishAlbumRemovals: vi.fn(async (_ids?: number[]) => 1),
  removeFromPlaylistWithUndo: vi.fn(async (pid: number, ids: number[]) => ({ playlist_id: pid, rows: ids.map((id, k) => ({ id, track_id: 1, added_at: "", k })) })),
  restorePlaylistTracks: vi.fn(async () => 1),
  deletePlaylistWithUndo: vi.fn(async (id: number) => ({ playlist: { id, name: "Mix", created_at: "", updated_at: "" }, rule_json: null, tracks: [], imported: [], pending: [] })),
  restorePlaylist: vi.fn(async () => 5),
});
let core: ReturnType<typeof extra>;

beforeEach(async () => {
  useFakeTimers();
  hs = await boot();
  core = Object.assign(hs.core, extra());
  undo = await import("../src/ui/undo");
  removals = await import("../src/lib/removals");
  const { UndoNote } = await import("../src/components/UndoNote");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(h(UndoNote)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const note = () => host.querySelector(".undo-note");
const offer = (text = "Removed A.") => {
  const o = { text, undo: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) };
  act(() => undo.offerUndo(o));
  return o;
};
const press = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true, ...init })); });

describe("the Undo note (#93)", () => {
  it("shows for 8 s, then finishes the removal and goes", async () => {
    const o = offer('Removed "Alpha".');
    expect(note()?.textContent).toBe('Removed "Alpha".Undo');
    expect(note()?.getAttribute("role")).toBe("status");
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS - 1); });
    expect(note()).not.toBeNull();
    expect(o.finish).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(note()).toBeNull();
    expect(o.finish).toHaveBeenCalledTimes(1);
    expect(o.undo).not.toHaveBeenCalled();
  });

  it("shows one at a time: a new removal finishes the one before", () => {
    const first = offer("Removed A.");
    act(() => { vi.advanceTimersByTime(5000); });
    const second = offer("Removed B.");
    expect(first.finish).toHaveBeenCalledTimes(1);
    expect(note()?.textContent).toContain("Removed B.");
    // The second gets its own full 8 s.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(second.finish).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(second.finish).toHaveBeenCalledTimes(1);
  });

  it("the Undo button undoes, and the removal is never finished", async () => {
    const o = offer();
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Undo");
    await act(async () => { button.click(); });
    expect(o.undo).toHaveBeenCalledTimes(1);
    expect(note()).toBeNull();
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS * 2); });
    expect(o.finish).not.toHaveBeenCalled();
  });

  it("⌘Z undoes while the note shows, but not from a text field and not afterwards", async () => {
    const o = offer();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ metaKey: true }, input);
    expect(o.undo).not.toHaveBeenCalled();
    press({ metaKey: true, shiftKey: true });
    expect(o.undo).not.toHaveBeenCalled();
    press({ metaKey: true });
    await flush();
    expect(o.undo).toHaveBeenCalledTimes(1);
    input.remove();

    const later = offer();
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS); });
    press({ metaKey: true });
    expect(later.undo).not.toHaveBeenCalled();
  });

  it("says so when an Undo fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const o = { text: "Removed A.", undo: vi.fn(async () => { throw new Error("db"); }) };
    act(() => undo.offerUndo(o));
    await act(async () => { host.querySelector("button")!.click(); });
    expect(note()?.textContent).toBe("Couldn't undo that.");
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS); });
    expect(note()).toBeNull();
    err.mockRestore();
  });
});

describe("removals with Undo (#93)", () => {
  it("an album is only marked; the delete runs when the note goes", async () => {
    await act(async () => { await removals.removeAlbumWithUndo({ id: 7, title: "Alpha" }); });
    expect(core.removeAlbumLater).toHaveBeenCalledWith(7);
    expect(note()?.textContent).toContain('Removed "Alpha".');
    expect(core.finishAlbumRemovals).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS); });
    await flush();
    expect(core.finishAlbumRemovals).toHaveBeenCalledWith([7]);
  });

  it("Undo of an album takes the mark off and deletes nothing", async () => {
    await act(async () => { await removals.removeAlbumWithUndo({ id: 7, title: "Alpha" }); });
    await act(async () => { await undo.undoNow(); });
    expect(core.undoRemoveAlbum).toHaveBeenCalledWith(7);
    act(() => { vi.advanceTimersByTime(undo.UNDO_MS); });
    expect(core.finishAlbumRemovals).not.toHaveBeenCalled();
  });

  it("an album that is not there (or already going) offers nothing", async () => {
    core.removeAlbumLater.mockResolvedValueOnce(false);
    expect(await removals.removeAlbumWithUndo({ id: 7, title: "Alpha" })).toBe(false);
    expect(note()).toBeNull();
  });

  it("closing the window finishes a pending album removal", async () => {
    const persist = await import("../src/player/persist");
    await persist.initPersistence();
    await act(async () => { await removals.removeAlbumWithUndo({ id: 7, title: "Alpha" }); });
    await act(async () => { await hs.win.closeHandler!({ preventDefault: () => undefined }); });
    expect(core.finishAlbumRemovals).toHaveBeenCalledWith([7]);
    expect(hs.win.hide).toHaveBeenCalled();
    expect(note()).toBeNull();
  });

  it("a playlist entry and a playlist come back from their snapshots", async () => {
    await act(async () => { await removals.removePlaylistTrackWithUndo(3, { playlist_track_id: 41, title: "One" }); });
    expect(core.removeFromPlaylistWithUndo).toHaveBeenCalledWith(3, [41]);
    expect(note()?.textContent).toContain('Removed "One" from the playlist.');
    press({ metaKey: true });
    await flush();
    expect(core.restorePlaylistTracks).toHaveBeenCalledWith({ playlist_id: 3, rows: [{ id: 41, track_id: 1, added_at: "", k: 0 }] });

    await act(async () => { await removals.deletePlaylistWithUndo({ id: 3, name: "Mix" }); });
    expect(note()?.textContent).toContain('Deleted "Mix".');
    await act(async () => { await undo.undoNow(); });
    expect(core.restorePlaylist).toHaveBeenCalledWith(expect.objectContaining({ playlist: expect.objectContaining({ id: 3 }) }));
  });
});
