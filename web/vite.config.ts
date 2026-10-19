import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import type { Plugin } from "vite";
// Same allowlist as core and the Tauri http scope (with scopeRedirects on).
import { isFetchableBandcampUrl } from "../packages/core/src/scrape/url";
import { mayCarryIdentity } from "../packages/core/src/scrape/fan";

// Runs inside the Tauri window; `tauri dev` starts this server and loads http://localhost:5173.
/** Redirect hops followed per proxied request, each re-checked against the allowlist. */
const MAX_REDIRECTS = 5;

/**
 * Browser-only dev mode: GET/POST /bc-proxy/<encoded url> is fetched server-side with Node's fetch
 * (plain headers, like the app does through Tauri) so Bandcamp pages load without CORS.
 */
function bandcampProxy(): Plugin {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  return {
    name: "bandcamp-proxy",
    configureServer(server) {
      server.middlewares.use("/bc-proxy/", async (req, res) => {
        try {
          const target = decodeURIComponent((req.url ?? "").replace(/^\//, ""));
          // Refusals carry x-bc-proxy-denied; browserFetch turns that into the plugin's scope error.
          const deny = (url: string) => { res.statusCode = 403; res.setHeader("x-bc-proxy-denied", encodeURI(url)); res.end(`not allowed: ${url}`); };
          if (!isFetchableBandcampUrl(target)) { deny(target); return; }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const headers: Record<string, string> = { "User-Agent": UA, Accept: req.headers.accept ?? "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };
          if (req.headers["content-type"]) headers["Content-Type"] = String(req.headers["content-type"]);
          // The identity cookie (sent as x-bc-cookie, see browserFetch) goes only to bandcamp.com hosts.
          const cookie = req.headers["x-bc-cookie"] ? String(req.headers["x-bc-cookie"]) : null;
          const withCookie = (url: string) => (cookie && mayCarryIdentity(url) ? { ...headers, Cookie: cookie } : headers);
          // Follow redirects by hand so every hop passes the same check as the first URL.
          let url = target;
          let r = await fetch(url, { method: req.method, headers: withCookie(url), body: body && req.method !== "GET" ? body : undefined, redirect: "manual" });
          // redirect: "manual" from the app (FetchQueue.resolveRedirect): report the first hop, never follow it.
          if (req.headers["x-bc-redirect"] === "manual" && r.status >= 300 && r.status < 400 && r.headers.get("location")) {
            await r.body?.cancel().catch(() => undefined);
            res.statusCode = 200;
            res.setHeader("x-bc-status", String(r.status));
            res.setHeader("x-bc-location", new URL(r.headers.get("location")!, url).toString());
            res.end();
            return;
          }
          for (let hop = 0; r.status >= 300 && r.status < 400 && r.headers.get("location"); hop++) {
            const next = new URL(r.headers.get("location")!, url).toString();
            if (hop >= MAX_REDIRECTS) { res.statusCode = 502; res.end("too many redirects"); return; }
            if (!isFetchableBandcampUrl(next)) { deny(next); return; }
            url = next;
            // Like reqwest, drop the cookie when a hop changes host.
            r = await fetch(url, { method: "GET", headers: new URL(url).host === new URL(target).host ? withCookie(url) : headers, redirect: "manual" });
          }
          res.statusCode = r.status;
          res.setHeader("content-type", r.headers.get("content-type") ?? "application/octet-stream");
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), bandcampProxy()],
  resolve: { alias: { "@bc/core": path.resolve(__dirname, "../packages/core/src/index.ts") } },
  clearScreen: false,
  // Pre-bundle every Tauri package up front, including ones only reached through dynamic
  // imports, so the dep optimizer never re-bundles (and swaps chunks) mid-session.
  optimizeDeps: {
    include: [
      "@tauri-apps/api/app", "@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/path", "@tauri-apps/api/webviewWindow", "@tauri-apps/api/window",
      "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-fs", "@tauri-apps/plugin-http", "@tauri-apps/plugin-opener", "@tauri-apps/plugin-sql",
    ],
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**"] },
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
  // Two pages: the app, and the mini player window (its own entry so it never loads the
  // player store, the audio element or the database; see web/src/mini/main.tsx).
  build: {
    outDir: "dist", emptyOutDir: true, target: "safari16",
    rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), mini: path.resolve(__dirname, "mini.html") } },
  },
});
