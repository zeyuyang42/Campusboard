import { useEffect, useRef } from "react";
import { isUndoKey, pauseUndo, resumeUndo, undoNow, useUndo } from "../ui/undo";

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * "Removed X. Undo" (#93), above the player bar while a removal can be undone. ⌘Z undoes it
 * too, but only while the note shows and never from a text field (there ⌘Z edits the text).
 */
export function UndoNote() {
  const note = useUndo((s) => s.note);
  const error = useUndo((s) => s.error);
  useEffect(() => {
    if (!note) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoKey(e) || e.defaultPrevented || editable(e.target)) return;
      e.preventDefault();
      void undoNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [note]);
  // The clock stops while the pointer is over the note or focus is in it.
  const over = useRef({ hover: false, focus: false });
  const set = (k: "hover" | "focus", on: boolean) => {
    over.current[k] = on;
    if (over.current.hover || over.current.focus) pauseUndo(); else resumeUndo();
  };
  useEffect(() => { if (!note) over.current = { hover: false, focus: false }; }, [note]);
  if (!note && !error) return null;
  return (
    <div className="undo-note" role="status" onMouseEnter={() => set("hover", true)} onMouseLeave={() => set("hover", false)}
      onFocus={() => set("focus", true)} onBlur={() => set("focus", false)}>
      {note ? (
        <>
          <span className="undo-text">{note.text}</span>
          <button className="btn sm" onClick={() => void undoNow()} title="Undo (⌘Z)">Undo</button>
        </>
      ) : <span className="error">{error}</span>}
    </div>
  );
}
