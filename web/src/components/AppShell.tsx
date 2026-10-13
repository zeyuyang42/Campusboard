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

export function AppShell() {
  const queueOpen = usePlayer((s) => s.queueOpen);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const nowPlayingOpen = useUi((s) => s.nowPlayingOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const location = useLocation();
  useEffect(() => { document.documentElement.classList.toggle("is-tauri", isTauri); }, []);
  useEffect(() => { setSidebarOpen(false); }, [location.pathname, setSidebarOpen]);
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
