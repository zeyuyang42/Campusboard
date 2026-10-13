import { usePlayer } from "../player/store";
import { ArtImage } from "./ArtImage";
import { CloseIcon, UpIcon, DownIcon } from "./Icons";

export function QueueDrawer() {
  const { queue, index, jumpTo, removeAt, move, clearQueue, setQueueOpen } = usePlayer();
  return (
    <aside className="queue">
      <header>
        <span>Queue</span>
        <span className="muted" style={{ fontWeight: 400 }}>{queue.length ? `${index + 1} / ${queue.length}` : ""}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={clearQueue} disabled={queue.length <= 1}>Clear</button>
        <button className="icon-btn" onClick={() => setQueueOpen(false)} title="Close (Q)"><CloseIcon /></button>
      </header>
      <div className="list">
        {queue.length === 0 && <div className="empty">Queue is empty</div>}
        {queue.map((t, i) => (
          <div key={`${t.id}-${i}`} className={`item ${i === index ? "current" : ""}`}>
            <ArtImage artId={t.art_id} size={7} alt="" />
            <div className="t" onClick={() => jumpTo(i)}>
              <div className="title">{t.title}</div>
              <div className="sub">{t.track_artist ?? t.artist_name} · {t.album_title}</div>
            </div>
            <div className="ops">
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up"><UpIcon /></button>
              <button className="icon-btn" disabled={i === queue.length - 1} onClick={() => move(i, i + 1)} title="Move down"><DownIcon /></button>
              <button className="icon-btn" disabled={i === index} onClick={() => removeAt(i)} title="Remove"><CloseIcon /></button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
