import { create } from "zustand";

interface UiState {
  sidebarOpen: boolean;
  nowPlayingOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setNowPlayingOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set, get) => ({
  sidebarOpen: false,
  nowPlayingOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open }),
}));
