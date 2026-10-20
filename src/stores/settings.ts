import { create } from "zustand";
import { toast } from "sonner";
import { getBackend, errorMessage } from "@/lib/backend";
import { DEFAULT_SETTINGS } from "@/lib/backend/defaults";
import type { Settings } from "@/lib/backend/types";
import { applyAppearanceAttributes } from "@/app/appearance";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  /** Optimistic: the UI updates instantly and rolls back if the engine rejects it. */
  update(patch: Partial<Settings>): Promise<void>;
}

function applyAppearance(s: Settings): void {
  // Applied before React re-renders, so anything reading CSS tokens sees the new theme.
  applyAppearanceAttributes(s.theme, s.accent, s.reducedMotion);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const settings = await getBackend().getSettings();
    applyAppearance(settings);
    set({ settings, loaded: true });
  },
  async update(patch) {
    const prev = get().settings;
    const next = { ...prev, ...patch };
    applyAppearance(next);
    set({ settings: next });
    try {
      const saved = await getBackend().updateSettings(patch);
      applyAppearance(saved);
      set({ settings: saved });
    } catch (err) {
      applyAppearance(prev);
      set({ settings: prev });
      const { title, description } = errorMessage(err);
      toast.error(title, { description });
    }
  },
}));
