import { vi } from "vitest";
import { FakeAudio } from "./fakeAudio";

// audio.ts creates its elements with `new Audio()`: every fresh import of it gets fakes.
vi.stubGlobal("Audio", FakeAudio);
// The store compares readyState with this constant.
if (typeof HTMLMediaElement === "undefined" || HTMLMediaElement.HAVE_METADATA !== 1) {
  vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 });
}

// getCore() answers with the in-memory stub the current test installed (harness.ts boot()).
vi.mock("../src/api/core", () => ({
  getCore: async () => (globalThis as { __fakeCore?: unknown }).__fakeCore,
  invalidateQueries: () => undefined,
  bindQueryClient: () => undefined,
}));

// persist.ts registers its close handler on the Tauri window: the test's fake one.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => (globalThis as { __fakeWindow?: unknown }).__fakeWindow,
}));
