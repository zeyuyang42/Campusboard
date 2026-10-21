import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { initPlayer } from "./player/init";
import { bindQueryClient } from "./api/invalidate";
import { initTheme } from "./theme/store";
import { initPalette } from "./theme/usePalette";
import { isTauri } from "./lib/env";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "./theme/tokens.css";
import "./styles.css";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });
bindQueryClient(qc);
void initTheme();
initPlayer(qc);
initPalette();
// WebKit's own context menu (Reload, Inspect Element) does not belong in the app;
// keep it only where the system menu is useful: text fields and selected text.
if (isTauri) {
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}
if (import.meta.env.VITE_SELFTEST === "1") import("./selftest").then((m) => m.runSelfTest());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
