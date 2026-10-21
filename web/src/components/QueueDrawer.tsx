import { usePlayer } from "../player/store";
import { CloseIcon } from "./Icons";
import { QueueList } from "./QueueList";

export function QueueDrawer() {
  const length = usePlayer((s) => s.queue.length);
  const index = usePlayer((s) => s.index);
  const clearQueue = usePlayer((s) => s.clearQueue);
  const setQueueOpen = usePlayer((s) => s.setQueueOpen);
  return (
    <aside className="queue" aria-label="Queue">
      <header>
        <span>Queue</span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{length ? `${index + 1} of ${length}` : ""}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={clearQueue} disabled={length <= 1}>Clear</button>
        <button className="icon-btn" onClick={() => setQueueOpen(false)} title="Close (Q)"><CloseIcon /></button>
      </header>
      <QueueList />
    </aside>
  );
}
