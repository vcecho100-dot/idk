import { create } from "zustand";

interface UiState {
  paletteOpen: boolean;
  cheatsheetOpen: boolean;
  jobsOpen: boolean;
  dragging: boolean;
  setPalette(open: boolean): void;
  setCheatsheet(open: boolean): void;
  setJobs(open: boolean): void;
  setDragging(dragging: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  cheatsheetOpen: false,
  jobsOpen: false,
  dragging: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setCheatsheet: (cheatsheetOpen) => set({ cheatsheetOpen }),
  setJobs: (jobsOpen) => set({ jobsOpen }),
  setDragging: (dragging) => set({ dragging }),
}));
