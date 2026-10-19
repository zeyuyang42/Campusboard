import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationText, shouldNotify, type NotifyInput } from "../src/lib/notifications";
import { boot, flush, track, useFakeTimers, type Harness } from "./harness";

const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => (cmd.endsWith("request_permission") ? "granted" : undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const base: NotifyInput = { enabled: true, trackId: 2, previousTrackId: 1, firstTrack: false, windowVisible: false, windowFocused: false };

describe("shouldNotify", () => {
  it("notifies for a new track while the window is hidden", () => {
    expect(shouldNotify(base)).toBe(true);
  });

  it("notifies while the window is open but in the background, not while it has focus", () => {
    expect(shouldNotify({ ...base, windowVisible: true, windowFocused: false })).toBe(true);
    expect(shouldNotify({ ...base, windowVisible: true, windowFocused: true })).toBe(false);
  });

  it("never when the setting is off", () => {
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
  });

  it("not for the first track after launch or restore", () => {
    expect(shouldNotify({ ...base, previousTrackId: null, firstTrack: true })).toBe(false);
  });

  it("not when the same track comes round again or nothing is playing", () => {
    expect(shouldNotify({ ...base, previousTrackId: 2 })).toBe(false);
    expect(shouldNotify({ ...base, trackId: null })).toBe(false);
  });

  it("does notify after the queue was empty once a track has been seen", () => {
    expect(shouldNotify({ ...base, previousTrackId: null })).toBe(true);
  });
});

describe("notificationText", () => {
  it("puts the track in the title and the artist and album in the body", () => {
    expect(notificationText({ title: "Song", track_artist: null, artist_name: "Band", album_title: "Record" })).toEqual({ title: "Song", body: "Band — Record" });
    expect(notificationText({ title: "Song", track_artist: "Guest", artist_name: "Band", album_title: "Record" }).body).toBe("Guest — Record");
  });

  it("drops an album named like the track (a single) and copes with missing parts", () => {
    expect(notificationText({ title: "Song", track_artist: null, artist_name: "Band", album_title: "Song" }).body).toBe("Band");
    expect(notificationText({ title: "Song", track_artist: null, artist_name: "", album_title: "Record" }).body).toBe("Record");
  });
});

describe("wiring", () => {
  let h: Harness;
  let mod: typeof import("../src/lib/notifications");
  const win = { visible: false, focused: false };
  const settle = async () => { await flush(); vi.advanceTimersByTime(mod.SETTLE_MS + 50); await flush(); };
  const notified = () => invoke.mock.calls.filter(([c]) => c === "plugin:notification|notify").map(([, a]) => (a as { options: unknown }).options);

  beforeEach(async () => {
    useFakeTimers();
    invoke.mockClear();
    win.visible = false; win.focused = false;
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    h = await boot();
    Object.assign(h.win, { isVisible: vi.fn(async () => win.visible), isFocused: vi.fn(async () => win.focused) });
    mod = await import("../src/lib/notifications");
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("is off by default and asks for nothing at launch", async () => {
    await mod.initTrackNotifications();
    await h.startPlaying([track(), track()]);
    h.state().next();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks for permission when turned on, then notifies on later track changes only", async () => {
    await mod.initTrackNotifications();
    await mod.useTrackNotifications.getState().setEnabled(true);
    expect(invoke).toHaveBeenCalledWith("plugin:notification|request_permission", undefined);
    expect(h.core.settings.get(mod.NOTIFY_SETTING_KEY)).toBe(true);

    await h.startPlaying([track({ title: "One" }), track({ title: "Two" })]);
    await settle();
    expect(notified()).toHaveLength(0); // the first track since launch

    h.state().next();
    await flush();
    expect(notified()).toHaveLength(0); // not before it settles
    await settle();
    expect(notified()).toEqual([{ title: "Two", body: "Artist — Album" }]);

    win.visible = true; win.focused = true;
    h.state().prev();
    await settle();
    expect(notified()).toHaveLength(1);
  });

  it("holding Next posts only the track it stops on", async () => {
    await mod.initTrackNotifications();
    await mod.useTrackNotifications.getState().setEnabled(true);
    await h.startPlaying([1, 2, 3, 4, 5].map((n) => track({ title: `T${n}` })));
    await settle();
    for (let i = 0; i < 4; i++) {
      h.state().next();
      await flush();
      vi.advanceTimersByTime(300);
    }
    await settle();
    expect(notified()).toEqual([{ title: "T5", body: "Artist — Album" }]);
  });

  it("skipping away and back before it settles posts nothing", async () => {
    await mod.initTrackNotifications();
    await mod.useTrackNotifications.getState().setEnabled(true);
    await h.startPlaying([track(), track()]);
    await settle();
    h.state().next();
    await flush();
    h.state().prev();
    await settle();
    expect(notified()).toHaveLength(0);
  });

  it("stays off when permission is refused", async () => {
    invoke.mockImplementationOnce(async () => "denied");
    await mod.initTrackNotifications();
    await mod.useTrackNotifications.getState().setEnabled(true);
    expect(mod.useTrackNotifications.getState()).toMatchObject({ enabled: false, denied: true });
    expect(h.core.settings.has(mod.NOTIFY_SETTING_KEY)).toBe(false);
  });
});
