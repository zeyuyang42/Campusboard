import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewReleaseTracks, type ParsedTralbum } from "@bc/core";
import { boot, flush, useFakeTimers, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

const RELEASE = "https://a.bandcamp.com/album/x";
const stream = (id: number) => `https://t4.bcbits.com/stream/abc/mp3-128/${id}?p=0&ts=1792659432&t=sig`;
const parsed = {
  item_type: "album", bandcamp_id: 1, artist: { band_id: 2, name: "A", url: "https://a.bandcamp.com" }, title: "X", url: RELEASE,
  art_id: 5, release_date: null, about: null, credits: null, tags: [], is_preorder: false, parent_album_id: null, featured_track_id: 12,
  tracks: [11, 12, 13].map((id, i) => ({
    track_id: id, title: `T${id}`, track_num: i + 1, duration: 100, artist: null, streamable: true,
    stream_url: stream(id), stream_quality: "mp3-128", stream_expires_at: null, lyrics: null,
  })),
} as unknown as ParsedTralbum;

function listen(el: ReturnType<Harness["active"]>, sec: number) {
  for (let i = 0; i < sec; i++) {
    vi.advanceTimersByTime(1000);
    el.emit("timeupdate", { currentTime: el.currentTime + 1 });
  }
}

describe("a previewed release from Search or Browse", () => {
  it("plays from the featured track, moves on to the next preview, and is not counted", async () => {
    const { tracks, start } = previewReleaseTracks(parsed, RELEASE);
    expect(start).toBe(1);
    const el = await h.startPlaying(tracks, start, 100);
    expect(h.state().queue.map((t) => t.preview?.track_id)).toEqual([11, 12, 13]);
    expect(h.state().index).toBe(1);
    expect(el.src).toBe(stream(12));
    listen(el, 95);
    el.end({ currentTime: 100 });
    await flush();
    expect(h.state().index).toBe(2);
    expect(h.core.previewStreamUrl).toHaveBeenCalledWith(expect.objectContaining({ track_id: 13 }), false);
    expect(h.active().src).toBe(stream(13));
    expect(h.core.getFreshStreamUrl).not.toHaveBeenCalled();
    expect(h.core.recordPlay).not.toHaveBeenCalled();
  });
});
