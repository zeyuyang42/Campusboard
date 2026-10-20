import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { QueueDrawer } from "./QueueDrawer";
import { Ambient } from "./Ambient";
import { MenuHost } from "./MenuHost";
import { CommandPalette } from "./CommandPalette";
import { NowPlaying } from "./NowPlaying";
import { DropLink } from "./DropLink";
import { UndoNote } from "./UndoNote";
import { usePlayer } from "../player/store";
import { useUi } from "../ui/store";
import { isTauri } from "../lib/env";
import { setNavigator } from "../lib/navigation";
import { useNavigate } from "react-router-dom";

export function AppShell() {
  const queueOpen = usePlayer((s) => s.queueOpen);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const nowPlayingOpen = useUi((s) => s.nowPlayingOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { document.documentElement.classList.toggle("is-tauri", isTauri); }, []);
  useEffect(() => { setNavigator((to) => (typeof to === "number" ? navigate(to) : navigate(to))); return () => setNavigator(null); }, [navigate]);
  useEffect(() => { setSidebarOpen(false); }, [location.pathname, setSidebarOpen]);
  useEffect(() => {
    if (!location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [location.hash, location.pathname, location.key]); // key: the same section chosen again scrolls again
  // Full screen hides the traffic lights, so give the title band back to content.
  useEffect(() => {
    if (!isTauri) return;
    // The listener arrives after an await: a cleanup that ran first (StrictMode) drops it then.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const sync = async () => document.documentElement.classList.toggle("is-fullscreen", await win.isFullscreen().catch(() => false));
      await sync();
      const u = await win.onResized(() => { void sync(); });
      if (cancelled) u(); else unlisten = u;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  return (
    <>
      <Ambient />
      {isTauri && <div className="titlebar-drag" data-tauri-drag-region />}
      {/* First in the tab order, so the Undo button is one Tab away. */}
      <UndoNote />
      <div className="shell">
        <Sidebar open={sidebarOpen} />
        <main className="main">
          <Outlet />
        </main>
        {nowPlayingOpen && <NowPlaying />}
        <PlayerBar />
        {queueOpen && !nowPlayingOpen && <QueueDrawer />}
      </div>
      <MenuHost />
      <CommandPalette />
      <DropLink />
    </>
  );
}
