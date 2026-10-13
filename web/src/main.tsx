import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { initPlayer } from "./player/init";
import { bindQueryClient } from "./api/core";
import { initTheme } from "./theme/store";
import { initPalette } from "./theme/usePalette";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "./styles.css";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });
bindQueryClient(qc);
void initTheme();
initPlayer(qc);
initPalette();
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
