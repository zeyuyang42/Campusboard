import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { positionToGain } from "@bc/core";
import { boot, flush, track, tracks, useFakeTimers, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  useFakeTimers();
  h = await boot();
});
afterEach(() => { vi.useRealTimers(); });

describe("toggle during buffering (#50)", () => {
  it("pauses a stalled track instead of asking it to play again", async () => {
    const el = await h.startPlaying(tracks(3));
    expect(h.state()).toMatchObject({ status: "playing", wantsPlay: true });
    el.emit("waiting");
    expect(h.state()).toMatchObject({ status: "loading", wantsPlay: true });

    const plays = el.calls.play;
    h.state().toggle();
    expect(el.paused).toBe(true);
    expect(el.calls.play).toBe(plays);
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });

    h.state().toggle();
    expect(h.state().wantsPlay).toBe(true);
    expect(el.calls.play).toBe(plays + 1);
  });

  it("a pause pressed while the stream URL resolves wins over the load", async () => {
    h.state().playTracks(tracks(2));
    expect(h.state().status).toBe("loading");
    h.state().toggle();
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
    await flush();
    expect(h.active().src).toContain("/stream/");
    expect(h.active().calls.play).toBe(0);
  });
});

describe("stale events and system pauses (#55)", () => {
  it("a play/playing/waiting handled after the listener paused changes nothing", async () => {
    const el = await h.startPlaying(tracks(2));
    h.state().pause();
    el.emit("pause");
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
    for (const type of ["play", "playing", "waiting"]) el.emit(type);
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
  });

  it("a pause from outside the store clears wantsPlay, so a retry doesn't resume", async () => {
    const el = await h.startPlaying(tracks(2));
    el.paused = true; // the system paused the element (output device gone, ...)
    el.emit("pause");
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });

    // An expired URL then fails: the retry reloads but stays paused.
    el.emit("error");
    await flush();
    expect(h.core.getFreshStreamUrl).toHaveBeenLastCalledWith(h.state().current()!.id, true);
    expect(el.calls.play).toBe(1);
    expect(h.state().wantsPlay).toBe(false);
  });

  it("a pause that ends the track is left to 'ended'", async () => {
    const el = await h.startPlaying(tracks(2));
    el.emit("pause", { paused: true, ended: true });
    expect(h.state()).toMatchObject({ status: "playing", wantsPlay: true });
  });
});

describe("skipping a track that fails (#67)", () => {
  const setVisibility = (v: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  afterEach(() => setVisibility("visible"));

  it("shows the error for a moment in a visible window, then moves on", async () => {
    const list = tracks(3);
    h.core.failing.add(list[0].id);
    h.state().playTracks(list);
    await flush();
    expect(h.state()).toMatchObject({ index: 0, status: "paused" });
    expect(h.state().error).toContain(list[0].title);
    vi.advanceTimersByTime(800);
    await flush();
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
  });

  it("moves on without a timer in a hidden window, where WebKit may never fire it", async () => {
    setVisibility("hidden");
    const list = tracks(3);
    h.core.failing.add(list[0].id);
    h.state().playTracks(list);
    await flush();
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a media error after the retry also moves on right away when hidden", async () => {
    setVisibility("hidden");
    const el = await h.startPlaying(tracks(2));
    el.emit("error"); // first: retried with a fresh URL
    await flush();
    el.emit("error"); // again: give up on this track
    expect(h.state().index).toBe(1);
  });

  describe("guards on the skip (#74 review)", () => {
    it("a queue edit mid-streak starts the count afresh, so the rest of the queue is still tried", async () => {
      const list = tracks(4);
      list.slice(0, 3).forEach((t) => h.core.failing.add(t.id));
      h.state().playTracks(list);
      await flush(); // A fails
      vi.advanceTimersByTime(800);
      await flush(); // B fails
      h.state().removeAt(0); // [B, C, D], at B
      vi.advanceTimersByTime(800);
      await flush(); // C fails
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 2, wantsPlay: true });
      expect(h.active().src).toContain(`/stream/${list[3].id}`);
    });

    it("a shuffle toggle mid-streak starts the count afresh", async () => {
      const list = tracks(4);
      h.core.failing.add(list[0].id).add(list[1].id);
      h.state().playTracks(list);
      await flush(); // A fails
      vi.advanceTimersByTime(800);
      await flush(); // B fails: streak 2
      h.state().toggleShuffle(); // [B, p, q, r]
      const q = h.state().queue;
      h.core.failing.clear();
      q.slice(0, 3).forEach((t) => h.core.failing.add(t.id));
      for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(800); await flush(); }
      expect(h.state()).toMatchObject({ index: 3, wantsPlay: true });
      expect(h.active().src).toContain(`/stream/${q[3].id}`);
    });

    it("Pause pressed while the error shows cancels the skip", async () => {
      const list = tracks(3);
      h.core.failing.add(list[0].id);
      h.state().playTracks(list);
      await flush();
      h.state().pause();
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 0, wantsPlay: false, status: "paused" });
    });

    it("a track picked while the error shows is not skipped", async () => {
      const list = tracks(3);
      h.core.failing.add(list[0].id);
      h.state().playTracks(list);
      await flush();
      h.state().jumpTo(2);
      await flush();
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 2, wantsPlay: true });
    });

    it("Play pressed while the error shows retries that track, not the previous source", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.core.failing.add(list[1].id);
      h.state().next();
      await flush(); // B fails; the element still holds A
      h.core.failing.clear();
      h.state().play();
      await flush();
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
      expect(el.src).toContain(`/stream/${list[1].id}`);
    });

    it("a media error while paused moves to the next track without playing it", async () => {
      setVisibility("hidden");
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.state().pause();
      el.emit("pause");
      el.emit("error"); // retried, still paused
      await flush();
      const plays = el.calls.play;
      el.emit("error");
      await flush();
      expect(h.state()).toMatchObject({ index: 1, wantsPlay: false, status: "paused" });
      expect(h.active().src).toContain(`/stream/${list[1].id}`);
      expect(h.active().calls.play).toBe(plays);
    });

    it("Next onto a failing URL leaves no element playing", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.core.failing.add(list[1].id);
      h.state().next();
      await flush();
      expect(h.state()).toMatchObject({ index: 1, status: "paused", wantsPlay: false });
      expect(h.els.every((e) => e.paused)).toBe(true);
      expect(el.src).toBe("");
    });

    it("a cooldown during a load leaves silence, and nothing advances when the old track would have ended", async () => {
      const list = tracks(3);
      h.state().cycleRepeat(); h.state().cycleRepeat(); // repeat-one
      const el = await h.startPlaying(list);
      h.core.getFreshStreamUrl.mockImplementationOnce(async () => { throw Object.assign(new Error("cooldown"), { code: "challenge_cooldown" }); });
      h.state().next();
      await flush();
      expect(h.els.every((e) => e.paused)).toBe(true);
      expect(el.src).toBe("");
      const calls = h.core.getFreshStreamUrl.mock.calls.length;
      const plays = el.calls.play;
      vi.advanceTimersByTime(200_000); // past where track 1 would have ended
      await flush();
      expect(h.state()).toMatchObject({ index: 1, status: "paused", wantsPlay: false });
      expect(h.core.getFreshStreamUrl.mock.calls.length).toBe(calls);
      expect(el.calls.play).toBe(plays);
    });

    it("removeAt during the window that leaves the failed track last doesn't wrap with repeat off", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.core.failing.add(list[1].id);
      h.state().next();
      await flush(); // B fails; skip pending
      h.state().removeAt(2); // [A, B]: B is now last
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 1, status: "paused", wantsPlay: false });
      expect(el.src).toBe("");
    });

    it("clearQueue during the window does no extra fetch", async () => {
      const list = tracks(3);
      h.core.failing.add(list[0].id);
      h.state().cycleRepeat(); // repeat-all, so only the one-track rule can stop it
      h.state().playTracks(list);
      await flush();
      h.state().clearQueue(); // [A], the failed track
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1);
      expect(h.state()).toMatchObject({ index: 0, wantsPlay: false });
    });

    it("a Bandcamp cooldown stops instead of skipping through the queue", async () => {
      const list = tracks(3);
      h.core.getFreshStreamUrl.mockImplementationOnce(async () => { throw Object.assign(new Error("cooldown"), { code: "challenge_cooldown" }); });
      h.state().playTracks(list);
      await flush();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(800);
      await flush();
      expect(h.state()).toMatchObject({ index: 0, wantsPlay: false, status: "paused" });
      expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("with repeat (#69)", () => {
    beforeEach(() => setVisibility("hidden"));

    it("repeat-one: a media error after the retry advances to the next track", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.state().cycleRepeat(); h.state().cycleRepeat();
      expect(h.state().repeat).toBe("one");
      el.emit("error");
      await flush();
      el.emit("error");
      await flush();
      expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
      expect(h.active().src).toContain(`/stream/${list[1].id}`);
    });

    it("repeat-one: a failed load advances instead of replaying the previous track's source", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.state().cycleRepeat(); h.state().cycleRepeat();
      h.core.failing.add(list[1].id);
      h.state().next(); // the listener presses Next onto a track that fails to load
      await flush();
      expect(h.state()).toMatchObject({ index: 2, wantsPlay: true });
      expect(h.active().src).toContain(`/stream/${list[2].id}`);
      expect(el.src).not.toContain(`/stream/${list[0].id}`);
    });

    it("repeat-all: a queue where every track fails stops instead of looping", async () => {
      const list = tracks(3);
      list.forEach((t) => h.core.failing.add(t.id));
      h.state().cycleRepeat();
      expect(h.state().repeat).toBe("all");
      h.state().playTracks(list, 1);
      await flush();
      await flush();
      expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(3);
      expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
      expect(h.state().index).toBe(0); // 1, 2, wrapped to 0, then stopped
    });

    it("repeat-all: a failure at the end of the queue wraps to a track that plays", async () => {
      const list = tracks(3);
      h.core.failing.add(list[2].id);
      h.state().cycleRepeat();
      h.state().playTracks(list, 2);
      await flush();
      expect(h.state()).toMatchObject({ index: 0, wantsPlay: true });
      expect(h.active().src).toContain(`/stream/${list[0].id}`);
    });

    it("repeat-one: the end of a track that played still replays it", async () => {
      const list = tracks(3);
      const el = await h.startPlaying(list);
      h.state().cycleRepeat(); h.state().cycleRepeat();
      const calls = h.core.getFreshStreamUrl.mock.calls.length;
      const plays = el.calls.play;
      el.end();
      await flush();
      expect(h.state().index).toBe(0);
      expect(el.currentTime).toBe(0);
      expect(el.calls.play).toBe(plays + 1);
      expect(h.core.getFreshStreamUrl.mock.calls.length).toBe(calls);
    });
  });
});

describe("the swapping flag", () => {
  it("the pause caused by swapping a playing element's source keeps wantsPlay", async () => {
    const el = await h.startPlaying(tracks(3));
    h.state().next();
    await flush();
    // WebKit: setting src + load() on a playing element pauses it and queues a "pause" task;
    // play() for the new source only takes effect once the media can play, so that "pause" is
    // handled while audio.paused is still true. paused: true models that window (the fake's
    // play() resolves at once, which would otherwise make the event stale).
    el.emit("pause", { paused: true });
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: true });
    el.emit("playing", { paused: false });
    expect(h.state()).toMatchObject({ status: "playing", wantsPlay: true, index: 1 });
  });

  it("is cleared when the new track plays without a pause event, so a later system pause counts", async () => {
    const el = await h.startPlaying(tracks(3));
    h.state().next();
    await flush();
    el.emit("playing");
    el.paused = true;
    el.emit("pause");
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
  });

  it("is cleared by a refused play()", async () => {
    const el = await h.startPlaying(tracks(3));
    el.playError = { name: "AbortError" };
    h.state().next();
    await flush();
    el.playError = null;
    el.emit("pause");
    expect(h.state().wantsPlay).toBe(false);
  });

  it("autoplay refused (NotAllowedError) stops intending to play", async () => {
    h.active().playError = { name: "NotAllowedError" };
    h.state().playTracks(tracks(2));
    await flush();
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
  });
});

describe("two elements (#35, #57)", () => {
  /** Preload the next track into the standby element and prime it until it is ready. */
  async function preloadNext(at = 75) {
    const el = h.active();
    el.emit("timeupdate", { currentTime: at });
    await flush();
    const sb = h.standby();
    expect(h.transitionInfo().phase).toBe("preloading");
    expect(sb.src).toContain(`/stream/${h.state().queue[h.state().index + 1].id}`);
    sb.emit("loadedmetadata", { duration: 100, readyState: 1 });
    expect(sb.muted).toBe(true); // priming plays it muted
    expect(sb.paused).toBe(false);
    sb.emit("timeupdate", { currentTime: 0.3 });
    expect(h.transitionInfo().phase).toBe("ready");
    expect(sb.paused).toBe(true);
    expect(sb.currentTime).toBe(0);
    return sb;
  }

  it("standby events never change the store", async () => {
    const el = await h.startPlaying(tracks(3));
    el.emit("timeupdate", { currentTime: 75 });
    await flush();
    const sb = h.standby();
    for (const type of ["play", "playing", "pause", "waiting", "ended", "durationchange", "seeking"]) sb.emit(type);
    expect(h.state()).toMatchObject({ status: "playing", wantsPlay: true, index: 0, duration: 100 });
    sb.emit("error");
    expect(h.transitionInfo().phase).toBe("failed");
    expect(sb.src).toBe("");
    expect(h.state()).toMatchObject({ status: "playing", error: null, index: 0 });
  });

  it("switches gaplessly on 'ended' without loading the next track again", async () => {
    const list = tracks(3);
    const el = await h.startPlaying(list);
    const sb = await preloadNext();
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(2);

    el.end({ currentTime: 100 });
    expect(h.active()).toBe(sb);
    expect(h.state()).toMatchObject({ index: 1, position: 0, wantsPlay: true });
    expect(sb.paused).toBe(false);
    expect(sb.muted).toBe(false);
    expect(sb.volume).toBe(positionToGain(h.state().volume));
    expect(h.core.getFreshStreamUrl).toHaveBeenCalledTimes(2);
    expect(h.transitionInfo().transitions.at(-1)).toMatchObject({ from: list[0].id, to: list[1].id, kind: "ended", fadeSec: 0 });

    // The previous element is now out of the store's way.
    el.emit("play");
    el.emit("pause");
    sb.emit("playing");
    expect(h.state()).toMatchObject({ status: "playing", index: 1 });
    vi.advanceTimersByTime(1000);
    expect(el.src).toBe(""); // released
  });

  it("starts the next element at the end from the arm timer (early start)", async () => {
    const el = await h.startPlaying(tracks(3));
    const sb = await preloadNext();
    el.emit("timeupdate", { currentTime: 99.9 });
    expect(h.active()).toBe(el); // armed, not started
    el.currentTime = 100;
    vi.advanceTimersByTime(100);
    expect(h.active()).toBe(sb);
    expect(h.transitionInfo()).toMatchObject({ phase: "fading" });
    expect(h.transitionInfo().transitions.at(-1)).toMatchObject({ kind: "gapless", fadeSec: 0 });
    // The previous element's own end finishes the tail; its events don't reach the store.
    el.end();
    expect(h.transitionInfo().phase).toBe("idle");
    expect(h.state()).toMatchObject({ index: 1, wantsPlay: true });
  });

  it("crossfades between tracks of different albums", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const list = [track({ album_id: 1 }), track({ album_id: 2 })];
    const el = await h.startPlaying(list);
    const sb = await preloadNext(70);
    el.emit("timeupdate", { currentTime: 95 }); // the fade's start: 100 - 5
    expect(h.active()).toBe(sb);
    expect(h.transitionInfo()).toMatchObject({ phase: "fading", paused: [false, false] });
    expect(h.transitionInfo().transitions.at(-1)).toMatchObject({ kind: "crossfade", fadeSec: 5 });
    expect(sb.volume).toBe(0);

    el.currentTime = 97.5; // half way
    vi.advanceTimersByTime(50);
    expect(el.volume).toBeCloseTo(Math.SQRT1_2, 5);
    expect(sb.volume).toBeCloseTo(Math.SQRT1_2, 5);

    el.currentTime = 100;
    vi.advanceTimersByTime(50);
    expect(h.transitionInfo().phase).toBe("idle");
    expect(sb.volume).toBe(1);
    expect(el.paused).toBe(true);
  });

  it("never crossfades within an album: a gapless switch at the end instead", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const el = await h.startPlaying(tracks(2, { album_id: 7 }));
    const sb = await preloadNext(75);
    el.emit("timeupdate", { currentTime: 95 });
    expect(h.active()).toBe(el);
    el.end({ currentTime: 100 });
    expect(h.active()).toBe(sb);
    expect(h.transitionInfo().transitions.at(-1)).toMatchObject({ kind: "ended", fadeSec: 0 });
  });

  it("pause mid-fade pauses both elements and freezes the fade; play resumes both", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const el = await h.startPlaying([track({ album_id: 1 }), track({ album_id: 2 })]);
    const sb = await preloadNext(70);
    el.emit("timeupdate", { currentTime: 95 });
    el.currentTime = 96;
    vi.advanceTimersByTime(50);
    const vols = [el.volume, sb.volume];

    h.state().pause();
    expect([el.paused, sb.paused]).toEqual([true, true]);
    el.currentTime = 99;
    vi.advanceTimersByTime(500);
    expect([el.volume, sb.volume]).toEqual(vols);
    expect(h.state().wantsPlay).toBe(false);

    h.state().play();
    expect([el.paused, sb.paused]).toEqual([false, false]);
    vi.advanceTimersByTime(50);
    expect(el.volume).toBeLessThan(vols[0]);
    expect(sb.volume).toBeGreaterThan(vols[1]);
  });

  it("a system pause of the active element mid-fade stops the fading one too", async () => {
    h.state().setPlayback({ crossfadeSec: 5 });
    const el = await h.startPlaying([track({ album_id: 1 }), track({ album_id: 2 })]);
    const sb = await preloadNext(70);
    el.emit("timeupdate", { currentTime: 95 });
    sb.emit("pause", { paused: true });
    expect(el.paused).toBe(true);
    expect(h.state()).toMatchObject({ status: "paused", wantsPlay: false });
  });
});

describe("MAX_QUEUE (#59)", () => {
  it("playTracks keeps a window of MAX_QUEUE that contains the chosen track", () => {
    const list = tracks(h.MAX_QUEUE + 5);
    expect(h.state().playTracks(list, h.MAX_QUEUE + 3)).toBe(h.MAX_QUEUE);
    expect(h.state().queue).toHaveLength(h.MAX_QUEUE);
    expect(h.state().current()!.id).toBe(list[h.MAX_QUEUE + 3].id);
    expect(h.state().queue.at(-1)!.id).toBe(list.at(-1)!.id);
  });

  it("enqueueNext and enqueueLast stop at the cap", () => {
    h.state().playTracks(tracks(h.MAX_QUEUE - 2));
    expect(h.state().enqueueNext(tracks(5))).toBe(2);
    expect(h.state().queue).toHaveLength(h.MAX_QUEUE);
    expect(h.state().enqueueLast(tracks(1))).toBe(0);
    expect(h.state().queue).toHaveLength(h.MAX_QUEUE);
  });

  it("hydrate caps an old uncapped queue", () => {
    const q = tracks(h.MAX_QUEUE + 10).map(h.toQueueTrack);
    h.state().hydrate({ queue: q, index: 0, position: 0, volume: 1, shuffle: false, repeat: "off" });
    expect(h.state().queue).toHaveLength(h.MAX_QUEUE);
  });

  it("drops lyrics and unstreamable tracks from the queue", () => {
    const list = [track({ streamable: false }), track({ lyrics: "la la" }), track()];
    expect(h.state().playTracks(list)).toBe(2);
    expect(h.state().queue.map((t) => t.lyrics)).toEqual([null, null]);
  });
});

describe("volume (#36)", () => {
  it("sets the element's gain through the cube curve", () => {
    h.state().setVolume(0.5);
    expect(h.active().volume).toBe(0.125);
    h.state().setVolume(2);
    expect(h.state().volume).toBe(1);
    h.state().setVolume(Number.NaN);
    expect(h.state().volume).toBe(0);
  });

  it("stepVolume moves the slider in clamped steps without drift", () => {
    h.state().setVolume(0.5);
    h.state().stepVolume(0.05);
    expect(h.state().volume).toBe(0.55);
    expect(h.active().volume).toBeCloseTo(0.55 ** 3, 10);
    h.state().setVolume(1);
    h.state().stepVolume(0.05);
    expect(h.state().volume).toBe(1);
    for (let i = 0; i < 20; i++) h.state().stepVolume(-0.05);
    expect(h.state().volume).toBe(0);
    expect(h.active().volume).toBe(0);
    for (let i = 0; i < 7; i++) h.state().stepVolume(0.05);
    expect(h.state().volume).toBe(0.35);
  });

  it("toggleMute goes to silence and back to the level before", () => {
    h.state().setVolume(0.6);
    h.state().toggleMute();
    expect(h.state().volume).toBe(0);
    expect(h.active().volume).toBe(0);
    h.state().toggleMute();
    expect(h.state().volume).toBe(0.6);
  });
});
