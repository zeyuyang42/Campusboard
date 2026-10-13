import { useState } from "react";

/** Native drag-and-drop reordering for a list of rows. */
export function useRowDrag(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const rowProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== i) setOver(i); },
    onDragLeave: () => { if (over === i) setOver(null); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag !== null && drag !== i) onMove(drag, i); setDrag(null); setOver(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const rowClass = (i: number) => `${drag === i ? "dragging" : ""} ${over === i && drag !== null && drag !== i ? "drop-target" : ""}`;
  return { rowProps, rowClass, dragging: drag !== null };
}
