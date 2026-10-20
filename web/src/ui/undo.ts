import { create } from "zustand";

/** How long a removal can be undone (#93). */
export const UNDO_MS = 8000;

export interface UndoOffer {
  /** "Removed ...", shown before the Undo button. */
  text: string;
  undo: () => Promise<unknown>;
  /** Makes the removal final (an album's delayed delete). Runs when the note goes without an Undo. */
  finish?: () => Promise<unknown>;
}

interface UndoState {
  note: (UndoOffer & { key: number }) | null;
  /** Shown in the note's place when an Undo failed. */
  error: string | null;
}

/** The one Undo note (MenuHost-style: a single one for the whole app). */
export const useUndo = create<UndoState>(() => ({ note: null, error: null }));

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const report = (e: unknown) => { console.error(`[undo] ${String(e)}`); };

function take(): UndoState["note"] {
  const n = useUndo.getState().note;
  if (timer) clearTimeout(timer);
  timer = null;
  if (n) useUndo.setState({ note: null });
  return n;
}

/** Offer Undo for UNDO_MS. One at a time: an offer still showing is finished first. */
export function offerUndo(offer: UndoOffer): void {
  void take()?.finish?.().catch(report);
  const key = ++seq;
  useUndo.setState({ note: { ...offer, key }, error: null });
  timer = setTimeout(() => {
    if (useUndo.getState().note?.key === key) void take()?.finish?.().catch(report);
  }, UNDO_MS);
}

/** Undo the removal on offer. False when there was none or it failed (the note says so). */
export async function undoNow(): Promise<boolean> {
  const n = take();
  if (!n) return false;
  try {
    await n.undo();
    return true;
  } catch (e) {
    report(e);
    const key = ++seq;
    useUndo.setState({ error: "Couldn't undo that." });
    timer = setTimeout(() => { if (seq === key) useUndo.setState({ error: null }); }, UNDO_MS);
    return false;
  }
}

/** Make the removal on offer final now (the window is closing). */
export async function finishUndo(): Promise<void> {
  await take()?.finish?.().catch(report);
}

/** ⌘Z (Ctrl+Z off the Mac), nothing else held. */
export const isUndoKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z";
