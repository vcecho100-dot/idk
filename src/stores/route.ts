import { create } from "zustand";

export type RouteName = "home" | "studio" | "library" | "settings";
export type SettingsSection = "general" | "providers" | "viewport" | "export" | "updates" | "privacy" | "about";

export interface Route {
  name: RouteName;
  projectId?: string;
  section?: SettingsSection;
}

interface RouteState {
  route: Route;
  /** The last studio project, so the Studio tab returns to it. */
  lastProjectId: string | null;
  history: Route[];
  navigate(route: Route): void;
  back(): void;
}

export const useRoute = create<RouteState>((set, get) => ({
  route: { name: "home" },
  lastProjectId: null,
  history: [],
  navigate(route) {
    const cur = get().route;
    if (cur.name === route.name && cur.projectId === route.projectId && cur.section === route.section) return;
    set({
      route,
      history: [...get().history.slice(-30), cur],
      lastProjectId: route.name === "studio" && route.projectId ? route.projectId : get().lastProjectId,
    });
  },
  back() {
    const h = get().history;
    const prev = h[h.length - 1];
    if (prev) set({ route: prev, history: h.slice(0, -1) });
  },
}));

export const navigate = (route: Route) => useRoute.getState().navigate(route);
