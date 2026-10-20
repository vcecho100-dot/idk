import { create } from "zustand";
import type { InputMode, ProviderId, Quality, StagedImage, Style, ViewSlot } from "@/lib/backend/types";

export const PROMPT_MAX = 600;

interface CreateState {
  mode: InputMode;
  prompt: string;
  negativePrompt: string;
  style: Style;
  quality: Quality;
  faceLimit: number | null;
  pbr: boolean;
  seed: number | null;
  variants: 1 | 4;
  provider: ProviderId | null;
  image: StagedImage | null;
  views: Record<ViewSlot, StagedImage | null>;
  submitting: boolean;
  set(patch: Partial<Omit<CreateState, "set" | "setView" | "reset">>): void;
  setView(slot: ViewSlot, image: StagedImage | null): void;
  reset(): void;
}

const initial = {
  mode: "text" as InputMode,
  prompt: "",
  negativePrompt: "",
  style: "stylized" as Style,
  quality: "standard" as Quality,
  faceLimit: null,
  pbr: true,
  seed: null,
  variants: 1 as const,
  provider: null,
  image: null,
  views: { front: null, side: null, back: null },
  submitting: false,
};

export const useCreate = create<CreateState>((set, get) => ({
  ...initial,
  set: (patch) => set(patch),
  setView: (slot, image) => set({ views: { ...get().views, [slot]: image } }),
  reset: () => set({ ...initial, provider: get().provider }),
}));
