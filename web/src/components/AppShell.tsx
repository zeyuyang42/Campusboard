import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { QueueDrawer } from "./QueueDrawer";
import { usePlayer } from "../player/store";

export function AppShell() {
  const queueOpen = usePlayer((s) => s.queueOpen);
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
      <PlayerBar />
      {queueOpen && <QueueDrawer />}
    </div>
  );
}
