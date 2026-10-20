import { useEffect, useState } from "react";
import { installDropLink } from "../lib/dropLink";

export const NOTE_MS = 3000;

/** Drop a Bandcamp link anywhere on the main window (#92): an outline while dragging, a note if it isn't one. */
export function DropLink() {
  const [active, setActive] = useState(false);
  // A fresh object per note, so the same message dropped twice restarts the timer.
  const [note, setNote] = useState<{ message: string } | null>(null);
  useEffect(() => installDropLink(window, { onActive: setActive, onNote: (message) => setNote({ message }) }), []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  return (
    <>
      {active && <div className="drop-outline" aria-hidden />}
      {note && <div className="drop-note" role="status">{note.message}</div>}
    </>
  );
}
