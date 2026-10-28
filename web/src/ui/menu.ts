import { create } from "zustand";

export type MenuItem =
  | { kind?: "item"; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { kind: "separator" }
  | { kind: "label"; label: string };

/** A list of items, the playlist picker for tracks, or the crate picker for albums (#126). */
export type MenuContent = { items: MenuItem[] } | { playlistPicker: { trackIds: number[] } } | { cratePicker: { albumIds: number[] } };

/** Reopen the menu where it is with other content (a submenu), on the next tick so the click that chose the item has settled. */
export function reopenMenuAs(content: MenuContent) {
  const m = useMenu.getState();
  setTimeout(() => m.show({ x: m.x, y: m.y }, content), 0);
}

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  content: MenuContent;
  returnFocus: HTMLElement | null;
  show: (at: { x: number; y: number } | HTMLElement, content: MenuContent) => void;
  close: () => void;
}

/** One menu host for the whole app: rows, cards and the queue all open menus through this. */
export const useMenu = create<MenuState>((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  content: { items: [] },
  returnFocus: null,
  show: (at, content) => {
    let x: number, y: number;
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      x = r.right; y = r.bottom + 4;
    } else { x = at.x; y = at.y; }
    set({ open: true, x, y, content, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  },
  close: () => {
    const rf = get().returnFocus;
    set({ open: false, returnFocus: null });
    rf?.focus?.();
  },
}));

/** Open a menu from a mouse event (right-click) or from a button (anchor). */
export function openMenuFromEvent(e: React.MouseEvent, content: MenuContent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.type === "contextmenu") useMenu.getState().show({ x: e.clientX, y: e.clientY }, content);
  else useMenu.getState().show(e.currentTarget as HTMLElement, content);
}
