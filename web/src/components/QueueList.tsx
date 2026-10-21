import { memo, useCallback, useRef } from "react";
import type { QueueTrack } from "@bc/core";
import { usePlayer } from "../player/store";
import { ArtImage } from "./ArtImage";
import { CloseIcon, MoreIcon } from "./Icons";
import { useRowDrag, type RowDragHandlers } from "../lib/useRowDrag";
import { useTrackActions } from "../lib/useTrackActions";
import { openMenuFromEvent, type MenuContent } from "../ui/menu";

type MenuFor = (t: QueueTrack, i: number, current: boolean) => MenuContent;

/**
 * The queue as a draggable list; used by the drawer and the now-playing view. Reads only the
 * queue and the index, so a position tick re-renders nothing here; each row is memoised.
 */
export function QueueList() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const move = usePlayer((s) => s.move);
  const { handlers, rowClass } = useRowDrag(move);
  const actions = useTrackActions();
  // One stable menu builder for every row (useTrackActions returns a new function each render).
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const menuFor = useCallback<MenuFor>((t, i, current) =>
    actionsRef.current([t], { remove: current ? undefined : { label: "Remove from queue", onSelect: () => usePlayer.getState().removeAt(i) } }), []);
  if (queue.length === 0) return <div className="queue-list"><div className="empty">Queue is empty. Play something and it shows up here.</div></div>;
  return (
    <div className="queue-list">
      {queue.map((t, i) => (
        <QueueRow key={`${t.id}-${i}`} track={t} index={i} current={i === index} dragClass={rowClass(i)} drag={handlers} menuFor={menuFor} />
      ))}
    </div>
  );
}

const QueueRow = memo(function QueueRow({ track: t, index: i, current, dragClass, drag, menuFor }: {
  track: QueueTrack; index: number; current: boolean; dragClass: string; drag: RowDragHandlers; menuFor: MenuFor;
}) {
  const jump = () => usePlayer.getState().jumpTo(i);
  const remove = () => usePlayer.getState().removeAt(i);
  return (
    <div
      className={`item ${current ? "current" : ""} ${dragClass}`}
      draggable
      onDragStart={(e) => drag.onDragStart(e, i)}
      onDragOver={(e) => drag.onDragOver(e, i)}
      onDragLeave={() => drag.onDragLeave(i)}
      onDrop={(e) => drag.onDrop(e, i)}
      onDragEnd={drag.onDragEnd}
      onContextMenu={(e) => openMenuFromEvent(e, menuFor(t, i, current))}
    >
      <ArtImage artId={t.art_id} imageId={t.radio?.image_id} size={7} alt="" />
      <div className="t" onClick={jump} onDoubleClick={jump}>
        <div className="title">{t.title}</div>
        <div className="sub meta"><span>{t.track_artist ?? t.artist_name}</span><span>{t.album_title}</span></div>
      </div>
      <div className="ops">
        <button className="icon-btn" title="More" onClick={(e) => openMenuFromEvent(e, menuFor(t, i, current))}><MoreIcon /></button>
        <button className="icon-btn" disabled={current} onClick={remove} title="Remove from queue"><CloseIcon /></button>
      </div>
    </div>
  );
});
