import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRadioTrack, previewQueueTrack, type DiscoverItem, type QueueTrack } from "@bc/core";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";
import { setupQuery } from "../src/pages/DiscoverPage";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const STREAM = "https://t4.bcbits.com/stream/abc/mp3-128/25866226?p=0&ts=1792659432&t=sig&token=x";
const ITEM: DiscoverItem = {
  url: "https://resonantlanguage.bandcamp.com/album/discorporate", title: "Discorporate", artist: "Resonant Language",
  artist_url: "https://resonantlanguage.bandcamp.com/music", art_id: 3014362078, item_type: "album", release_date: "2026-09-04",
  track_count: 6, preorder: false, album_id: null,
  featured: { track_id: 25866226, title: "Discorporate", artist: "Resonant Language", duration: 162.9, stream_url: STREAM },
};
const preview = (p: Partial<DiscoverItem> = {}): QueueTrack => previewQueueTrack({ ...ITEM, ...p })!;

function listen(el: ReturnType<Harness["active"]>, sec: number) {
  for (let i = 0; i < sec; i++) {
    vi.advanceTimersByTime(1000);
    el.emit("timeupdate", { currentTime: el.currentTime + 1 });
  }
}

describe("a Discover preview in the player (#104)", () => {
  it("plays the stored featured-track URL through the preview function", async () => {
    const el = await h.startPlaying([preview()], 0, 162.9);
    expect(h.core.previewStreamUrl).toHaveBeenCalledWith(expect.objectContaining({ track_id: 25866226, stream_url: STREAM }), false);
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalled();
    expect(h.core.localTrackUrl).not.toHaveBeenCalled();
    expect(el.src).toBe(STREAM);
    expect(h.state()).toMatchObject({ status: "playing", index: 0 });
  });

  it("gets a new URL once after a media error", async () => {
    const el = await h.startPlaying([preview()], 0, 162.9);
    el.emit("error");
    await flush();
    expect(h.core.previewStreamUrl).toHaveBeenLastCalledWith(expect.objectContaining({ track_id: 25866226 }), true);
    expect(el.src).toBe("https://t4.bcbits.test/stream/refreshed/25866226");
  });

  it("is not counted in listening history", async () => {
    const el = await h.startPlaying([preview()], 0, 162.9);
    listen(el, 120);
    await flush();
    expect(h.core.recordPlay).not.toHaveBeenCalled();
  });

  it("survives a restart without a request until Play", async () => {
    const saved = preview();
    const t = track();
    h.state().hydrate({ queue: [JSON.parse(JSON.stringify(saved)), t], index: 0, position: 40, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    expect(h.state().current()).toEqual(saved);
    expect(h.state().queue).toHaveLength(2);
    expect(h.core.previewStreamUrl).not.toHaveBeenCalled();
    h.state().play();
    await flush();
    expect(h.core.previewStreamUrl).toHaveBeenCalledWith(saved.preview, false);
  });

  it("drops a restored entry whose preview field is malformed", async () => {
    const bad = { ...preview(), preview: { item_url: "https://evil.example/x", track_id: 1, stream_url: "https://evil.example/stream" } };
    const positive = { ...preview(), id: 5 }; // a preview must keep its negative id
    h.state().hydrate({ queue: [bad, positive, track({ id: 9 }) as QueueTrack], index: 0, position: 0, volume: 1, shuffle: false, repeat: "off" });
    await flush();
    expect(h.state().queue.map((q) => q.id)).toEqual([9]);
  });

  it("is not a radio episode, so the Radio-only UI leaves it alone", () => {
    expect(isRadioTrack(preview())).toBe(false);
    expect(preview().radio).toBeUndefined();
  });
});

describe("the remembered Discover setup", () => {
  it("restores a saved setup as the page's query, validated", () => {
    expect(setupQuery({ tags: ["electronic", "glitch"], slice: "new", time: 1, location: 2950159, location_label: "Berlin, Berlin" }))
      .toBe("tags=electronic%2Cglitch&s=new&t=1&loc=2950159&locname=Berlin%2C%20Berlin");
    expect(setupQuery({ tags: [3, "ok"], slice: "bogus", time: 99, location: -4, location_label: "x" })).toBe("tags=ok&s=top");
    expect(setupQuery(null)).toBeNull();
    expect(setupQuery("nope")).toBeNull();
  });
});

describe("previews and resume points", () => {
  it("never saves or reads one, even for a preview over 20 minutes", async () => {
    const long = preview({ featured: { ...ITEM.featured!, duration: 3600 } });
    const el = await h.startPlaying([long], 0, 3600);
    el.emit("timeupdate", { currentTime: 2480 });
    h.state().pause();
    el.emit("pause");
    await flush();
    expect(h.core.saveResumePosition).not.toHaveBeenCalled();
    expect(h.core.resumePosition).not.toHaveBeenCalled();
  });
});
