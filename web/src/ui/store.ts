import { create } from "zustand";

interface UiState {
  sidebarOpen: boolean;
  nowPlayingOpen: boolean;
  creatingPlaylist: boolean;
  /** The Library filter text, kept for the session so opening an album and coming back keeps it. */
  libraryQuery: string;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setNowPlayingOpen: (open: boolean) => void;
  setCreatingPlaylist: (on: boolean) => void;
  setLibraryQuery: (q: string) => void;
}

export const useUi = create<UiState>((set, get) => ({
  sidebarOpen: false,
  nowPlayingOpen: false,
  creatingPlaylist: false,
  libraryQuery: "",
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open }),
  setCreatingPlaylist: (on) => set({ creatingPlaylist: on }),
  setLibraryQuery: (q) => set({ libraryQuery: q }),
}));
