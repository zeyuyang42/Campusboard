// Entry of the mini player window (mini.html, Tauri label `mini`). A separate Vite entry
// rather than a route of the app: this bundle must never import the player store (it owns
// the one <audio>), getCore (a second database connection, job runner and release checker)
// or the app shell. Everything it shows arrives from the main window over the bus.
import React from "react";
import ReactDOM from "react-dom/client";
import { MiniPlayer } from "./MiniPlayer";
import { isTauri } from "../lib/env";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "./mini.css";

if (isTauri) {
  document.documentElement.classList.add("is-tauri");
  // A remote has no use for WebKit's context menu (Reload, Inspect Element).
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MiniPlayer />
  </React.StrictMode>,
);
