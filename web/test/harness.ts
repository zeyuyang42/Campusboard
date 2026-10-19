import { vi } from "vitest";
import type { PlayState, Track } from "@bc/core";
import type { FakeAudio } from "./fakeAudio";

const DAY_MS = 24 * 3600 * 1000;

/** The calls the player makes on getCore(), in memory. */
export function makeFakeCore() {
  const settings = new Map<string, unknown>();
  const core = {
    settings,
    state: { current_track_id: null, position_sec: 0, queue: [], queue_index: 0, shuffle: false, repeat: "off", volume: 1 } as PlayState,
    /** Track ids whose stream URL fails. */
    failing: new Set<number>(),
    getFreshStreamUrl: vi.fn(async (trackId: number, force = false) => {
      if (core.failing.has(trackId)) throw new Error("no stream");
      return { url: `https://t4.bcbits.test/stream/${trackId}${force ? "?force" : ""}`, expires_at: Date.now() + DAY_MS };
    }),
    playState: vi.fn(async () => core.state),
    savePlayState: vi.fn(async (_s: PlayState) => undefined),
    savePlayPosition: vi.fn(async (_trackId: number | null, _sec: number, _index: number) => undefined),
    recordPlay: vi.fn(async (_trackId: number, _sec: number) => undefined),
    getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: unknown) => { settings.set(key, value); }),
    getArtPalette: vi.fn(async () => null),
  };
  return core;
}
export type FakeCore = ReturnType<typeof makeFakeCore>;

/** The Tauri window persist.ts talks to. */
export function makeFakeWindow() {
  const win = {
    closeHandler: null as null | ((e: { preventDefault: () => void }) => Promise<void>),
    onCloseRequested: vi.fn(async (cb: (e: { preventDefault: () => void }) => Promise<void>) => { win.closeHandler = cb; return () => undefined; }),
    hide: vi.fn(async () => undefined),
  };
  return win;
}

export function useFakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"], now: new Date("2026-10-19T12:00:00Z") });
}

/** Let pending promise chains (getCore, getFreshStreamUrl, play()) settle. */
export async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let nextId = 1;
export function track(p: Partial<Track> = {}): Track {
  const id = p.id ?? nextId++;
  return {
    id, track_id: id, album_id: 1, title: `Track ${id}`, track_num: 1, duration: 100, track_artist: null,
    streamable: true, lyrics: null, album_title: "Album", artist_name: "Artist", art_id: null, ...p,
  };
}
export const tracks = (n: number, p: Partial<Track> = {}) => Array.from({ length: n }, () => track(p));

/**
 * A fresh module graph: new audio elements, a new store and a new fake core. The store keeps
 * module state (the active element, the transition), so every test starts from its own.
 */
export async function boot() {
  vi.resetModules();
  const core = makeFakeCore();
  const win = makeFakeWindow();
  Object.assign(globalThis, { __fakeCore: core, __fakeWindow: win });
  const audio = await import("../src/player/audio");
  const store = await import("../src/player/store");
  const els = audio.audioEls as unknown as readonly [FakeAudio, FakeAudio];
  const active = () => store.activeAudio() as unknown as FakeAudio;
  const standby = () => (els[0] === active() ? els[1] : els[0]);
  const state = () => store.usePlayer.getState();

  /** Queue `list` from `start` and bring the track to "playing" as a real element would. */
  async function startPlaying(list: Track[], start = 0, duration = 100) {
    state().playTracks(list, start);
    await flush();
    const el = active();
    el.emit("loadedmetadata", { duration, readyState: 1 });
    el.emit("play");
    el.emit("playing");
    return el;
  }

  return { core, win, els, active, standby, state, startPlaying, ...store };
}
export type Harness = Awaited<ReturnType<typeof boot>>;
