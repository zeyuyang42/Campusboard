import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CommandPalette, PALETTE_DEBOUNCE_MS } from "../src/components/CommandPalette";
import { openPalette, usePalette } from "../src/ui/palette";
import { setNavigator } from "../src/lib/navigation";
import { initShortcuts } from "../src/player/shortcuts";
import { runMenuAction } from "../src/lib/appMenu";
import { usePlayer } from "../src/player/store";
import { useUi } from "../src/ui/store";
import { fold, matches, PALETTE_ACTIONS } from "../src/lib/paletteActions";
import { useMenu } from "../src/ui/menu";
import { SearchPage } from "../src/pages/SearchPage";
import { navigateTo } from "../src/lib/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fakeCore = {
  albums: vi.fn(async (_sort: string, _filter: string, q: string, _tag?: string, _opts?: { limit?: number }) =>
    [{ id: 7, title: "Boards Album", artist_name: "Boards of Canada" }, { id: 8, title: "Other", artist_name: "X" }].filter((a) => matches(`${a.title} ${a.artist_name}`, q))),
  artists: vi.fn(async () => [{ id: 3, name: "Boards of Canada", album_count: 1 }, { id: 4, name: "Zoë Keating", album_count: 1 }]),
  playlists: vi.fn(async () => [{ id: 5, name: "Bossa evenings" }, { id: 6, name: "Run" }]),
  crates: vi.fn(async () => [{ id: 9, name: "Bought on tour" }, { id: 10, name: "Late nights" }]),
  search: vi.fn(async () => []),
};

let host: HTMLDivElement;
let root: Root;
let path = "";
let before: HTMLButtonElement;
const player = { toggle: vi.fn(), toggleShuffle: vi.fn(), cycleRepeat: vi.fn(), setQueueOpen: vi.fn(), setSleep: vi.fn(), next: vi.fn(), prev: vi.fn() };

function Nav() {
  const navigate = useNavigate();
  const loc = useLocation();
  path = loc.pathname + loc.search + loc.hash;
  useEffect(() => { setNavigator((to) => (typeof to === "number" ? navigate(to) : navigate(to))); return () => setNavigator(null); }, [navigate]);
  return null;
}

beforeAll(() => initShortcuts());
beforeEach(() => {
  (globalThis as { __fakeCore?: unknown }).__fakeCore = fakeCore;
  Object.values(player).forEach((f) => f.mockClear());
  fakeCore.albums.mockClear();
  usePlayer.setState(player as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  before = document.createElement("button");
  before.textContent = "focused before";
  document.body.appendChild(before);
  before.focus();
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: ["/library"] }, h(Nav), h(Routes, null, h(Route, { path: "/search", element: h(SearchPage) }), h(Route, { path: "*", element: null })), h(CommandPalette)))));
});
afterEach(() => {
  act(() => usePalette.getState().hide(false));
  act(() => root.unmount());
  host.remove();
  before.remove();
  useUi.getState().setNowPlayingOpen(false);
});

const input = () => document.querySelector<HTMLInputElement>("[data-palette-input]");
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const labels = () => options().map((o) => o.querySelector(".palette-label")!.textContent);
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = input() ?? window) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Past the debounce, and long enough for the queries to settle. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, PALETTE_DEBOUNCE_MS + 20)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}
const open = () => act(() => openPalette());

describe("command palette (#72)", () => {
  it("opens on ⌘K with the input focused and accessible names in place", () => {
    expect(input()).toBeNull();
    key("k", { metaKey: true }, window);
    const el = input()!;
    expect(el).not.toBeNull();
    expect(document.activeElement).toBe(el);
    expect(el.getAttribute("role")).toBe("combobox");
    expect(el.getAttribute("aria-controls")).toBe("palette-list");
    expect(el.getAttribute("aria-label")).toBeTruthy();
    expect(document.getElementById("palette-list")!.getAttribute("role")).toBe("listbox");
    expect(el.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("does not take a ⌘K something focused already handled", () => {
    before.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    key("k", { metaKey: true }, before);
    expect(input()).toBeNull();
  });

  it("opens from the native menu id like the other Cmd shortcuts", () => {
    act(() => { expect(runMenuAction("command-palette")).toBe(true); });
    expect(input()).not.toBeNull();
  });

  it("closes on Esc and gives focus back", () => {
    open();
    expect(document.activeElement).toBe(input());
    key("Escape");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("Esc closes only the palette, not Now Playing behind it", () => {
    useUi.getState().setNowPlayingOpen(true);
    open();
    key("Escape");
    expect(input()).toBeNull();
    expect(useUi.getState().nowPlayingOpen).toBe(true);
  });

  it("lists albums, artists, playlists and crates from the library search, then matching actions", async () => {
    open();
    type("bo");
    await settle();
    // Archived albums (#126) stay a jump away from here.
    expect(fakeCore.albums).toHaveBeenCalledWith("title", "all", "bo", "", { limit: 6, archived: "any" });
    // "Keyboard shortcuts" has a "bo" too: actions follow the library results.
    expect(labels()).toEqual(["Boards Album", "Boards of Canada", "Bossa evenings", "Bought on tour", "Settings: Keyboard shortcuts", "Search Bandcamp for “bo”"]);
    expect([...document.querySelectorAll(".palette-group")].map((g) => g.textContent)).toEqual(["Albums", "Artists", "Playlists", "Crates", "Actions"]);
    type("keating");
    await settle();
    expect(labels()).toEqual(["Zoë Keating", "Search Bandcamp for “keating”"]);
    type("zoe");
    await settle();
    expect(labels()[0]).toBe("Zoë Keating"); // diacritics folded
  });

  it("debounces the library query", async () => {
    open();
    type("b");
    type("bo");
    type("boa");
    await settle();
    expect(fakeCore.albums.mock.calls.map((c) => c[2])).toEqual(["boa"]);
  });

  it("moves with ↑/↓ and opens the chosen result with Enter", async () => {
    open();
    type("bo");
    await settle();
    key("ArrowDown");
    expect(input()!.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    key("ArrowUp");
    key("ArrowUp"); // wraps to the last
    expect(options()[options().length - 1].getAttribute("aria-selected")).toBe("true");
    key("ArrowDown"); // back to the first
    key("Enter");
    expect(input()).toBeNull();
    expect(path).toBe("/album/7");
  });

  it("runs an action and returns focus where it was", async () => {
    open();
    type("play/pause");
    expect(labels()[0]).toBe("Play/Pause");
    key("Enter");
    await settle(); // Enter waits out the debounce, then runs the highlighted action
    expect(player.toggle).toHaveBeenCalledTimes(1);
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("offers settings sections, theme modes, sleep timer and Search Bandcamp with the typed text", async () => {
    open();
    type("sleep 30");
    expect(labels()[0]).toBe("Sleep timer: 30 minutes");
    key("Enter");
    await settle();
    expect(player.setSleep).toHaveBeenCalledWith(30);
    open();
    type("settings storage");
    key("Enter");
    await settle();
    expect(path).toBe("/settings#storage");
    open();
    type("aphex twin");
    expect(labels()).toEqual(["Search Bandcamp for “aphex twin”"]);
    key("Enter");
    await settle();
    expect(path).toBe("/search?q=aphex%20twin");
    const ids = PALETTE_ACTIONS.map((a) => a.id);
    for (const id of ["play-pause", "next", "previous", "import", "search-bandcamp", "mini-player", "theme:dark", "theme:light", "theme:system", "sleep:off", "sleep:album", "settings:theme"]) expect(ids).toContain(id);
  });

  it("does not trigger plain-key shortcuts while typing", () => {
    open();
    for (const k of [" ", "s", "S", "r", "q", "n", "/", "ArrowLeft", "ArrowRight"]) key(k);
    expect(player.toggle).not.toHaveBeenCalled();
    expect(player.toggleShuffle).not.toHaveBeenCalled();
    expect(player.cycleRepeat).not.toHaveBeenCalled();
    expect(player.setQueueOpen).not.toHaveBeenCalled();
    expect(input()).not.toBeNull();
  });

  it("always offers Bandcamp search for text nothing else matches", () => {
    open();
    type("qqqzzz");
    expect(labels()).toEqual(["Search Bandcamp for “qqqzzz”"]);
    expect(input()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("Enter before the library results land waits for them and opens the album", async () => {
    open();
    type("boards album");
    // Right now only "Search Bandcamp for …" is listed: the album is still on its way.
    expect(labels()).toEqual(["Search Bandcamp for “boards album”"]);
    key("Enter");
    expect(input()).not.toBeNull();
    await settle();
    expect(input()).toBeNull();
    expect(path).toBe("/album/7");
  });

  it("keeps the highlighted row when results arrive", async () => {
    open();
    type("bo");
    key("End"); // "Search Bandcamp for “bo”", before the albums land
    const chosen = options().find((o) => o.getAttribute("aria-selected") === "true")!.textContent;
    expect(chosen).toBe("Search Bandcamp for “bo”");
    await settle();
    expect(labels()[0]).toBe("Boards Album");
    const still = options().find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(still.textContent).toBe(chosen);
    expect(input()!.getAttribute("aria-activedescendant")).toBe(still.id);
  });

  it("closes an open context menu when it opens", () => {
    act(() => useMenu.getState().show({ x: 10, y: 10 }, { items: [] }));
    expect(useMenu.getState().open).toBe(true);
    open();
    expect(useMenu.getState().open).toBe(false);
    expect(input()).not.toBeNull();
  });

  it("keeps its status message outside the listbox", () => {
    open();
    const status = document.querySelector(".palette [role=status]")!;
    expect(status).not.toBeNull();
    expect(status.closest("[role=listbox]")).toBeNull();
    expect([...document.getElementById("palette-list")!.querySelectorAll("[role]")].every((el) => ["group", "option"].includes(el.getAttribute("role")!))).toBe(true);
  });

  it("Search Bandcamp refills the search field each time, even with the same text", async () => {
    open();
    type("aphex");
    key("End");
    key("Enter");
    await settle();
    const field = () => document.querySelector<HTMLInputElement>("[data-search-input]")!;
    expect(field().value).toBe("aphex");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), "something else");
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(field().value).toBe("something else");
    act(() => navigateTo("/search?q=aphex"));
    expect(field().value).toBe("aphex");
  });

  it("folds case and diacritics for matching", () => {
    expect(fold("Éclair")).toBe("eclair");
    expect(matches("Sleep timer: End of album", "end album")).toBe(true);
    expect(matches("Next track", "prev")).toBe(false);
  });
});
