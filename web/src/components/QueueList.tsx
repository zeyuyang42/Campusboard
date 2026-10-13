import { usePlayer } from "../player/store";
import { ArtImage } from "./ArtImage";
import { CloseIcon, MoreIcon } from "./Icons";
import { useRowDrag } from "../lib/useRowDrag";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent } from "../ui/menu";

/** The queue as a draggable list; used by the drawer and the now-playing view. */
export function QueueList() {
  const { queue, index, jumpTo, removeAt, move } = usePlayer();
  const { rowProps, rowClass } = useRowDrag(move);
  const actions = useTrackActions();
  if (queue.length === 0) return <div className="queue-list"><div className="empty">Queue is empty. Play something and it shows up here.</div></div>;
  return (
    <div className="queue-list">
      {queue.map((t, i) => (
        <div
          key={`${t.id}-${i}`}
          className={`item ${i === index ? "current" : ""} ${rowClass(i)}`}
          {...rowProps(i)}
          onContextMenu={(e) => openMenuFromEvent(e, actions([t], { remove: i === index ? undefined : { label: "Remove from queue", onSelect: () => removeAt(i) } }))}
        >
          <ArtImage artId={t.art_id} size={7} alt="" />
          <div className="t" onClick={() => jumpTo(i)} onDoubleClick={() => jumpTo(i)}>
            <div className="title">{t.title}</div>
            <div className="sub meta"><span>{t.track_artist ?? t.artist_name}</span><span>{t.album_title}</span></div>
          </div>
          <div className="ops">
            <button className="icon-btn" title="More" onClick={(e) => openMenuFromEvent(e, actions([t], { remove: i === index ? undefined : { label: "Remove from queue", onSelect: () => removeAt(i) } }))}><MoreIcon /></button>
            <button className="icon-btn" disabled={i === index} onClick={() => removeAt(i)} title="Remove from queue"><CloseIcon /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
