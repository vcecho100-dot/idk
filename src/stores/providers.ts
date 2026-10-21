import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import type { ProviderId, ProviderInfo } from "@/lib/backend/types";

interface ProvidersState {
  list: ProviderInfo[];
  loaded: boolean;
  load(): Promise<void>;
}

export const useProviders = create<ProvidersState>((set) => ({
  list: [],
  loaded: false,
  async load() {
    try {
      set({ list: await getBackend().listProviders(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
}));

export function providerById(list: ProviderInfo[], id: ProviderId): ProviderInfo | undefined {
  return list.find((p) => p.id === id);
}
