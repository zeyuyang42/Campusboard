import { useEffect, useState } from "react";
import { installDropLink } from "../lib/dropLink";

const NOTE_MS = 3000;

/** Drop a Bandcamp link anywhere on the main window (#92): an outline while dragging, a note if it isn't one. */
export function DropLink() {
  const [active, setActive] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => installDropLink(window, { onActive: setActive, onNote: setNote }), []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  return (
    <>
      {active && <div className="drop-outline" aria-hidden />}
      {note && <div className="drop-note" role="status">{note}</div>}
    </>
  );
}
