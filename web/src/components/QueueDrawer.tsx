import { usePlayer } from "../player/store";
import { CloseIcon } from "./Icons";
import { QueueList } from "./QueueList";

export function QueueDrawer() {
  const { queue, index, clearQueue, setQueueOpen } = usePlayer();
  return (
    <aside className="queue" aria-label="Queue">
      <header>
        <span>Queue</span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{queue.length ? `${index + 1} of ${queue.length}` : ""}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={clearQueue} disabled={queue.length <= 1}>Clear</button>
        <button className="icon-btn" onClick={() => setQueueOpen(false)} title="Close (Q)"><CloseIcon /></button>
      </header>
      <QueueList />
    </aside>
  );
}
