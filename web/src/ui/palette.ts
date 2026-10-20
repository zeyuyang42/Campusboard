// The command palette (#72): open state, and where focus goes back when it closes.
import { create } from "zustand";
import { useMenu } from "./menu";

interface PaletteState {
  open: boolean;
  /** The element that had focus before the palette opened. */
  returnFocus: HTMLElement | null;
  show: () => void;
  /** Close; focus returns to where it was unless `restore` is false (a result took the user elsewhere). */
  hide: (restore?: boolean) => void;
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  returnFocus: null,
  show: () => {
    if (get().open) {
      // ⌘K again: back to the input, nothing else.
      document.querySelector<HTMLInputElement>("[data-palette-input]")?.select();
      return;
    }
    // One floating thing at a time: an open context menu closes (and gives its focus back) first.
    if (useMenu.getState().open) useMenu.getState().close();
    const active = document.activeElement;
    set({ open: true, returnFocus: active instanceof HTMLElement && active !== document.body ? active : null });
  },
  hide: (restore = true) => {
    if (!get().open) return;
    const el = get().returnFocus;
    set({ open: false, returnFocus: null });
    if (restore && el && el.isConnected) el.focus({ preventScroll: true });
  },
}));

export const openPalette = () => usePalette.getState().show();
