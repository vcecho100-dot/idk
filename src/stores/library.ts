import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import type { Project } from "@/lib/backend/types";

interface LibraryState {
  projects: Project[];
  loaded: boolean;
  load(): Promise<void>;
  /** Optimistically patches a project in the list (e.g. favorite toggles). */
  patch(id: string, patch: Partial<Project>): void;
  drop(id: string): void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  projects: [],
  loaded: false,
  async load() {
    const projects = await getBackend().listProjects();
    set({ projects, loaded: true });
  },
  patch(id, patch) {
    set({ projects: get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  },
  drop(id) {
    set({ projects: get().projects.filter((p) => p.id !== id) });
  },
}));
