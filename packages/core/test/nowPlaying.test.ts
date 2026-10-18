import { describe, it, expect } from "vitest";
import { finiteDuration, nowPlayingMetadata, positionState, PositionThrottle, sessionPlaybackState } from "../src/services/nowPlaying.js";

const track = { title: "Pool Hopping", track_artist: null, artist_name: "illuminati hotties", album_title: "Let Me Do One More", art_id: 1234567 };

describe("nowPlayingMetadata", () => {
  it("maps a queue track, preferring the track artist", () => {
    const m = nowPlayingMetadata(track);
    expect(m).toMatchObject({ title: "Pool Hopping", artist: "illuminati hotties", album: "Let Me Do One More" });
    expect(nowPlayingMetadata({ ...track, track_artist: "Guest" }).artist).toBe("Guest");
  });

  it("offers the CDN sizes with 700px first (older WebKit loads only artwork[0])", () => {
    const { artwork } = nowPlayingMetadata(track);
    expect(artwork.map((a) => a.sizes)).toEqual(["700x700", "350x350", "1200x1200", "160x160"]);
    expect(artwork[0]).toEqual({ src: "https://f4.bcbits.com/img/a0001234567_16.jpg", sizes: "700x700", type: "image/jpeg" });
    expect(artwork.every((a) => a.src.startsWith("https://f4.bcbits.com/img/a"))).toBe(true);
  });

  it("has no artwork without an art id and never undefined strings", () => {
    const m = nowPlayingMetadata({ ...track, art_id: null, artist_name: "", album_title: "" });
    expect(m.artwork).toEqual([]);
    expect(m.artist).toBe("");
    expect(m.album).toBe("");
  });
});

describe("sessionPlaybackState", () => {
  it("maps the player status", () => {
    expect(sessionPlaybackState("playing", true, "none")).toBe("playing");
    expect(sessionPlaybackState("paused", true, "playing")).toBe("paused");
    expect(sessionPlaybackState("idle", true, "playing")).toBe("none");
    expect(sessionPlaybackState("playing", false, "playing")).toBe("none");
  });

  it("keeps the previous state while loading, so Next never flashes paused", () => {
    expect(sessionPlaybackState("loading", true, "playing")).toBe("playing");
    expect(sessionPlaybackState("loading", true, "paused")).toBe("paused");
    expect(sessionPlaybackState("loading", true, "none")).toBe("playing");
  });
});

describe("finiteDuration and positionState", () => {
  it("guards NaN, Infinity and zero durations", () => {
    expect(finiteDuration(NaN, 200)).toBe(200);
    expect(finiteDuration(Infinity, null)).toBeNull();
    expect(finiteDuration(0, 0)).toBeNull();
    expect(finiteDuration(181.5, 200)).toBe(181.5);
    expect(finiteDuration(undefined, NaN)).toBeNull();
  });

  it("only returns states WebKit's setPositionState accepts", () => {
    expect(positionState(null, 3, 1)).toBeNull();
    expect(positionState(NaN, 3, 1)).toBeNull();
    expect(positionState(Infinity, 3, 1)).toBeNull();
    expect(positionState(100, 120, 1)).toEqual({ duration: 100, position: 100, playbackRate: 1 });
    expect(positionState(100, -2, 1)).toEqual({ duration: 100, position: 0, playbackRate: 1 });
    expect(positionState(100, NaN, 0)).toEqual({ duration: 100, position: 0, playbackRate: 1 });
    expect(positionState(100, 5, 1.5)).toEqual({ duration: 100, position: 5, playbackRate: 1.5 });
  });
});

describe("PositionThrottle", () => {
  const at = (position: number, duration = 200) => ({ duration, position, playbackRate: 1 });

  it("reports the first state, then stays quiet during steady playback", () => {
    const t = new PositionThrottle(10_000, 1.5);
    expect(t.next(at(0), true, 0)).toBe(true);
    // timeupdate every 250 ms, matching wall time: no reports
    let reports = 0;
    for (let ms = 250; ms < 10_000; ms += 250) if (t.next(at(ms / 1000), true, ms)) reports++;
    expect(reports).toBe(0);
    // the periodic resync
    expect(t.next(at(10), true, 10_000)).toBe(true);
  });

  it("reports a seek, a play/pause change and a new duration", () => {
    const t = new PositionThrottle(10_000, 1.5);
    t.next(at(10), true, 0);
    expect(t.next(at(60), true, 1000)).toBe(true); // seek ahead
    expect(t.next(at(61), true, 2000)).toBe(false);
    expect(t.next(at(61), false, 2100)).toBe(true); // paused
    expect(t.next(at(61), false, 5000)).toBe(false); // paused: the position is expected to stay
    expect(t.next(at(61), true, 5100)).toBe(true); // resumed
    expect(t.next(at(0), true, 5200)).toBe(true); // restart (Previous, repeat-one)
    expect(t.next(at(0.2, 198.4), true, 5400)).toBe(true); // the media's own duration arrives
  });

  it("reports again after reset (a new track)", () => {
    const t = new PositionThrottle();
    t.next(at(0), true, 0);
    expect(t.next(at(0.1), true, 100)).toBe(false);
    t.reset();
    expect(t.next(at(0.1), true, 100)).toBe(true);
  });
});
