import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { previewQueueTrack, type DiscoverItem, type DiscoverPage } from "@bc/core";
import { useTrackActions } from "../src/lib/useTrackActions";
import { keys, markDiscoverInLibrary } from "../src/api/queries";
import type { MenuContent } from "../src/ui/menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM: DiscoverItem = {
  url: "https://a.bandcamp.com/album/x", title: "X", artist: "A", artist_url: "https://a.bandcamp.com/music", art_id: 5, item_type: "album",
  release_date: null, track_count: 3, preorder: false, album_id: null,
  featured: { track_id: 7, title: "Seven", artist: "A", duration: 120, stream_url: "https://t4.bcbits.com/stream/abc/mp3-128/7?p=0&ts=1792659432&t=sig" },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const labels = (c: MenuContent | null): string[] =>
  c && "items" in c ? c.items.map((i) => ("label" in i ? String(i.label) : "-")) : [];

describe("the track menu on a Discover preview (#104)", () => {
  it("offers Add album to library and no playlist", () => {
    let menu: MenuContent | null = null;
    function Probe() {
      menu = useTrackActions()([previewQueueTrack(ITEM)!]);
      return null;
    }
    act(() => root.render(h(MemoryRouter, null, h(Probe))));
    const l = labels(menu);
    expect(l).toContain("Add album to library");
    expect(l).toContain("Open on Bandcamp");
    expect(l.some((x) => /playlist/i.test(x))).toBe(false);
    expect(l).not.toContain("Go to album");
    expect(l).not.toContain("Go to Radio");
  });
});

describe("markDiscoverInLibrary", () => {
  it("patches every cached discover page holding the release, and nothing else", () => {
    const qc = new QueryClient();
    const params = { tags: ["x"], slice: "top" as const, time: null, location: null };
    const page: DiscoverPage = { items: [ITEM, { ...ITEM, url: "https://b.bandcamp.com/album/y" }], total: 2, cursor: null };
    qc.setQueryData(keys.discover(params), { pages: [page], pageParams: [null] });
    const tags = [{ norm_name: "glitch", display_name: "glitch", count: 1 }];
    qc.setQueryData(keys.discoverTags("gl"), tags);
    markDiscoverInLibrary(qc, ITEM.url, 42);
    const d = qc.getQueryData<{ pages: DiscoverPage[] }>(keys.discover(params))!;
    expect(d.pages[0].items.map((i) => i.album_id)).toEqual([42, null]);
    expect(qc.getQueryData(keys.discoverTags("gl"))).toEqual(tags);
  });
});
