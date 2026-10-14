import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { QueueDrawer } from "./QueueDrawer";
import { Ambient } from "./Ambient";
import { MenuHost } from "./MenuHost";
import { NowPlaying } from "./NowPlaying";
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
  }, [location.hash, location.pathname]);
  // Full screen hides the traffic lights, so give the title band back to content.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const sync = async () => document.documentElement.classList.toggle("is-fullscreen", await win.isFullscreen().catch(() => false));
      await sync();
      unlisten = await win.onResized(() => { void sync(); });
    });
    return () => unlisten?.();
  }, []);
  return (
    <>
      <Ambient />
      {isTauri && <div className="titlebar-drag" data-tauri-drag-region />}
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
    </>
  );
}
