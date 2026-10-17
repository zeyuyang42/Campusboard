import type { QueryClient } from "@tanstack/react-query";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createCore, type Core } from "@bc/core";
import { openDb } from "./tauriDb";

const BROWSER_MODE = import.meta.env.VITE_BROWSER_MODE === "1";

let corePromise: Promise<Core> | null = null;
let qc: QueryClient | null = null;

/** Called once at boot so job updates can invalidate queries. */
export function bindQueryClient(client: QueryClient) {
  qc = client;
}

/** Refetch every query whose key starts with one of `prefixes` (for code outside React). */
export function invalidateQueries(prefixes: string[]) {
  for (const k of prefixes) void qc?.invalidateQueries({ queryKey: [k] });
}

/** The app's single data layer: one SQLite file plus rate-limited Bandcamp fetches. */
export function getCore(): Promise<Core> {
  if (!corePromise) {
    corePromise = (async () => {
      let db: Awaited<ReturnType<typeof openDb>>;
      let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
      if (BROWSER_MODE) {
        const b = await import("./browserDb");
        db = await b.openBrowserDb();
        fetchImpl = b.browserFetch;
      } else {
        db = await openDb();
        fetchImpl = (input, init) => tauriFetch(input, { ...init, maxRedirections: 5 });
      }
      return createCore({
        db,
        fetch: fetchImpl,
        onJobsChange: () => {
          void qc?.invalidateQueries({ queryKey: ["jobs"] });
          void qc?.invalidateQueries({ queryKey: ["job"] });
          // A collection sync updates the account summary and the Purchased/Wishlist flags.
          void qc?.invalidateQueries({ queryKey: ["account"] });
        },
      });
    })();
  }
  return corePromise;
}
