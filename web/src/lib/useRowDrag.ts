import { useMemo, useRef, useState } from "react";

/** The drag handlers with the row index as a second argument: one stable set for a whole list. */
export interface RowDragHandlers {
  onDragStart: (e: React.DragEvent, i: number) => void;
  onDragOver: (e: React.DragEvent, i: number) => void;
  onDragLeave: (i: number) => void;
  onDrop: (e: React.DragEvent, i: number) => void;
  onDragEnd: () => void;
}

/**
 * Native drag-and-drop reordering for a list of rows. `rowProps(i)` spreads onto a row;
 * `handlers` are the same functions with the index as an argument, stable across renders so a
 * memoised row can take them as props.
 */
export function useRowDrag(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const latest = useRef({ drag, over, onMove });
  latest.current = { drag, over, onMove };
  const handlers = useMemo<RowDragHandlers>(() => ({
    onDragStart: (e, i) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; },
    onDragOver: (e, i) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (latest.current.over !== i) setOver(i); },
    onDragLeave: (i) => { if (latest.current.over === i) setOver(null); },
    onDrop: (e, i) => { e.preventDefault(); const from = latest.current.drag; if (from !== null && from !== i) latest.current.onMove(from, i); setDrag(null); setOver(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  }), []);
  const rowProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => handlers.onDragStart(e, i),
    onDragOver: (e: React.DragEvent) => handlers.onDragOver(e, i),
    onDragLeave: () => handlers.onDragLeave(i),
    onDrop: (e: React.DragEvent) => handlers.onDrop(e, i),
    onDragEnd: handlers.onDragEnd,
  });
  const rowClass = (i: number) => `${drag === i ? "dragging" : ""} ${over === i && drag !== null && drag !== i ? "drop-target" : ""}`;
  return { rowProps, rowClass, handlers, dragging: drag !== null };
}
