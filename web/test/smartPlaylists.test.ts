import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { repos, type Playlist, type PlaylistWithTracks, type Track } from "@bc/core";
import { PlaylistsPage } from "../src/pages/PlaylistsPage";
import { PlaylistPage } from "../src/pages/PlaylistPage";
import { MenuHost } from "../src/components/MenuHost";
import { useMenu } from "../src/ui/menu";
import { MAX_QUEUE, usePlayer } from "../src/player/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const track = (id: number, streamable = true): Track => ({
  id, track_id: id, album_id: 1, title: `Track ${id}`, track_num: id, duration: 100, track_artist: null, streamable, lyrics: null,
  album_title: "Album", artist_name: "Artist", art_id: null,
});
const RULE = repos.parseSmartRule({ minRating: 4, tag: "ambient" })!;
const smartList: Playlist = { id: 1, name: "Faves", created_at: "", updated_at: "", track_count: 2, art_ids: [], smart: true, rule: RULE };
const plainList: Playlist = { id: 2, name: "Mix", created_at: "", updated_at: "", track_count: 0, art_ids: [], smart: false, rule: null };
const smartOpen: PlaylistWithTracks = { ...smartList, tracks: [track(1), track(2)].map((t, i) => ({ ...t, playlist_track_id: -(i + 1), position: i })) };

let evaluated: Track[] = [];
const core = {
  playlists: vi.fn(async () => [smartList, plainList]),
  playlist: vi.fn(async () => smartOpen),
  tags: vi.fn(async () => [{ tag: "ambient", album_count: 2 }, { tag: "techno", album_count: 1 }]),
  smartCount: vi.fn(async (r: repos.SmartRule) => (r.minRating >= 4 ? 3 : 12)),
  smartTracks: vi.fn(async () => evaluated),
  createSmartPlaylist: vi.fn(async (name: string, rule: repos.SmartRule) => ({ ...smartList, id: 9, name, rule })),
  setSmartRule: vi.fn(async () => true),
  deletePlaylist: vi.fn(async () => true),
  playlistsContaining: vi.fn(async () => new Set<number>()),
};
const player = { playTracks: vi.fn((t: Track[]) => Math.min(MAX_QUEUE, t.filter((x) => x.streamable).length)), toggleShuffle: vi.fn(), shuffle: false };

let host: HTMLDivElement;
let root: Root;
let path = "";
function Where() {
  path = useLocation().pathname;
  return null;
}

beforeEach(() => {
  (globalThis as { __fakeCore?: unknown }).__fakeCore = core;
  for (const f of Object.values(core)) f.mockClear();
  player.playTracks.mockClear();
  player.toggleShuffle.mockClear();
  usePlayer.setState(player as never);
  evaluated = [track(1), track(2), track(3, false)];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (at: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: [at] }, h(Where), h(MenuHost), h(Routes, null,
    h(Route, { path: "/playlists", element: h(PlaylistsPage) }),
    h(Route, { path: "/playlists/:id", element: h(PlaylistPage) }))))));
};
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); await flush(); };
async function setValue(el: HTMLInputElement | HTMLSelectElement, v: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  await act(async () => { el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  await flush();
}
const field = (label: string) => [...host.querySelectorAll(".smart-editor .field")].find((f) => f.textContent?.startsWith(label))!.querySelector("input, select") as HTMLInputElement | HTMLSelectElement;
const status = () => host.querySelector(".smart-editor [role=status]")?.textContent;

describe("the smart playlist editor (#84)", () => {
  it("marks smart playlists quietly in the list", async () => {
    render("/playlists");
    await flush();
    const rows = [...host.querySelectorAll(".pl-list a")];
    expect(rows[0].querySelector(".smart-mark")?.textContent).toBe("Smart");
    expect(rows[1].querySelector(".smart-mark")).toBeNull();
  });

  it("builds a rule from plain fields, counts matches live and creates the playlist", async () => {
    render("/playlists");
    await flush();
    await click(button("New smart playlist"));
    expect(status()).toBe("12 tracks match");
    expect(button("Create").disabled).toBe(true); // no name yet

    await setValue(field("Name"), "  Faves ");
    await setValue(field("Rating"), "4");
    await setValue(field("Tag"), "ambient");
    await setValue(field("Played"), "not");
    await setValue(host.querySelector<HTMLInputElement>("input[aria-label=Days]")!, "90");
    await setValue(field("Sort"), "rating");
    const calls = core.smartCount.mock.calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    await flush();
    // Debounced: one count for the whole burst of changes.
    expect(core.smartCount.mock.calls.length).toBe(calls + 1);
    expect(status()).toBe("3 tracks match");
    expect(core.smartCount).toHaveBeenLastCalledWith({ show: "all", minRating: 4, tag: "ambient", notPlayedWithinDays: 90, sort: "rating", limit: 500 });

    await click(button("Create"));
    expect(core.createSmartPlaylist).toHaveBeenCalledWith("Faves", { show: "all", minRating: 4, tag: "ambient", notPlayedWithinDays: 90, sort: "rating", limit: 500 });
    expect(path).toBe("/playlists/9");
  });

  it("won't save a limit or day count out of bounds", async () => {
    render("/playlists");
    await flush();
    await click(button("New smart playlist"));
    await setValue(field("Name"), "X");
    await setValue(field("Limit"), "0");
    expect(button("Create").disabled).toBe(true);
    expect(status()).toMatch(/limit from 1 to 10,000/);
    await setValue(field("Limit"), "25");
    expect(button("Create").disabled).toBe(false);
    await setValue(field("Played"), "within");
    await setValue(host.querySelector<HTMLInputElement>("input[aria-label=Days]")!, "99999");
    expect(button("Create").disabled).toBe(true);
  });
});

describe("a smart playlist's page (#84)", () => {
  it("plays and shuffles the rule as it evaluates now, without reorder handles", async () => {
    render("/playlists/1");
    await flush();
    expect(host.querySelector(".page-title .smart-mark")?.textContent).toBe("Smart");
    expect(host.querySelector("[draggable=true]")).toBeNull();

    await click(button("Play"));
    expect(core.smartTracks).toHaveBeenCalledWith(RULE);
    expect(player.playTracks).toHaveBeenCalledWith(evaluated);

    await click(button("Shuffle"));
    expect(player.toggleShuffle).toHaveBeenCalled();
    expect(player.playTracks).toHaveBeenCalledTimes(2);
  });

  it("says when the queue cap cut the set short", async () => {
    evaluated = Array.from({ length: MAX_QUEUE + 5 }, (_, i) => track(i + 1));
    render("/playlists/1");
    await flush();
    await click(button("Play"));
    expect(host.querySelector(".bulk-bar [role=status]")?.textContent).toBe(`Queued the first ${MAX_QUEUE.toLocaleString()} of ${(MAX_QUEUE + 5).toLocaleString()} tracks: the queue holds at most ${MAX_QUEUE.toLocaleString()}.`);
  });

  it("edits the rule inline and deletes with a confirm", async () => {
    render("/playlists/1");
    await flush();
    await click(button("Edit rule"));
    expect((field("Rating") as HTMLSelectElement).value).toBe("4");
    expect((field("Tag") as HTMLSelectElement).value).toBe("ambient");
    await setValue(field("Rating"), "5");
    await click(button("Save rule"));
    expect(core.setSmartRule).toHaveBeenCalledWith(1, { show: "all", minRating: 5, tag: "ambient", sort: "added" });
    expect(host.querySelector(".smart-editor")).toBeNull();

    await click(button("Delete"));
    expect(core.deletePlaylist).not.toHaveBeenCalled();
    await click(button("Delete playlist"));
    expect(core.deletePlaylist).toHaveBeenCalledWith(1);
    expect(path).toBe("/playlists");
  });

  it("is left out of the Add to playlist picker", async () => {
    render("/playlists");
    await flush();
    const anchor = host.querySelector("h1") as HTMLElement;
    await act(async () => { useMenu.getState().show(anchor, { playlistPicker: { trackIds: [1] } }); });
    await flush();
    const names = [...document.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);
    expect(names.some((n) => n?.includes("Mix"))).toBe(true);
    expect(names.some((n) => n?.includes("Faves"))).toBe(false);
    act(() => useMenu.getState().close());
  });
});
