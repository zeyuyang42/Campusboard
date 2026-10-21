import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createCore, type Core, type OfflineFiles } from "@bc/core";
import { openDb } from "./tauriDb";
import { memoryOfflineFiles, tauriOfflineFiles } from "./offlineFiles";
import { invalidateGroup, invalidateQueries } from "./invalidate";

// The query-client binding lives in invalidate.ts; re-exported here for the player store.

const BROWSER_MODE = import.meta.env.VITE_BROWSER_MODE === "1";
const SELFTEST = import.meta.env.VITE_SELFTEST === "1";

let corePromise: Promise<Core> | null = null;

/** The app's single data layer: one SQLite file plus rate-limited Bandcamp fetches. */
export function getCore(): Promise<Core> {
  if (!corePromise) {
    corePromise = (async () => {
      let db: Awaited<ReturnType<typeof openDb>>;
      let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
      let files: OfflineFiles | null;
      if (BROWSER_MODE) {
        const b = await import("./browserDb");
        db = await b.openBrowserDb();
        fetchImpl = b.browserFetch;
        files = memoryOfflineFiles();
      } else {
        db = await openDb();
        files = await tauriOfflineFiles();
        // redirect: "manual" (FetchQueue.resolveRedirect) maps to the plugin's maxRedirections: 0,
        // which answers with the 3xx itself and its Location header (reqwest Policy::none).
        fetchImpl = (input, init) => tauriFetch(input, { ...init, maxRedirections: init?.redirect === "manual" ? 0 : 5 });
      }
      const core = createCore({
        db,
        fetch: fetchImpl,
        files,
        onJobsChange: () => invalidateGroup("jobs"),
        onReleasesChange: () => invalidateQueries(["releases"]),
        // A pre-order that came out: its tracks became playable.
        onLibraryChange: () => invalidateGroup("libraryTracks"),
      });
      // Background new-release checks and collection refresh: the first look a few minutes after
      // launch. The selftest runs its own single checks instead, so its requests stay predictable.
      if (!SELFTEST) {
        core.startReleaseChecks();
        core.startCollectionRefresh();
      }
      return core;
    })();
  }
  return corePromise;
}
