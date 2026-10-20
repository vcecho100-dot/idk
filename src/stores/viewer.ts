import { create } from "zustand";

export type RenderMode = "textured" | "clay" | "wireframe" | "normals" | "uv" | "maps";
export type MapChannel = "baseColor" | "normal" | "roughness" | "metalness" | "occlusion" | "emissive";
export type LightingPreset = "studio" | "soft" | "sunset" | "night" | "neon" | "outdoor";
export type ViewportBackground = "gradient" | "solid" | "environment" | "transparent";

export const RENDER_MODES: { id: RenderMode; label: string; shortcut?: string }[] = [
  { id: "textured", label: "Textured", shortcut: "T" },
  { id: "clay", label: "Clay", shortcut: "C" },
  { id: "wireframe", label: "Wireframe", shortcut: "W" },
  { id: "normals", label: "Normals", shortcut: "N" },
  { id: "uv", label: "UV checker", shortcut: "U" },
  { id: "maps", label: "Texture maps", shortcut: "M" },
];

export const MAP_CHANNELS: { id: MapChannel; label: string }[] = [
  { id: "baseColor", label: "Base color" },
  { id: "normal", label: "Normal" },
  { id: "roughness", label: "Roughness" },
  { id: "metalness", label: "Metalness" },
  { id: "occlusion", label: "Occlusion" },
  { id: "emissive", label: "Emissive" },
];

export const LIGHTING_PRESETS: { id: LightingPreset; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "soft", label: "Soft box" },
  { id: "sunset", label: "Sunset" },
  { id: "night", label: "Moonlight" },
  { id: "neon", label: "Neon" },
  { id: "outdoor", label: "Outdoor" },
];

export const BACKGROUNDS: { id: ViewportBackground; label: string }[] = [
  { id: "gradient", label: "Gradient" },
  { id: "solid", label: "Solid" },
  { id: "environment", label: "Environment" },
  { id: "transparent", label: "Transparent" },
];

interface Prefs {
  lighting: LightingPreset;
  background: ViewportBackground;
  showGrid: boolean;
  showStats: boolean;
}

const PREFS_KEY = "shift3d.viewer";

function loadPrefs(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

interface ViewerState extends Prefs {
  renderMode: RenderMode;
  mapChannel: MapChannel;
  turntable: boolean;
  focusMode: boolean;
  /** Bumped to request a camera reset. */
  frameRequest: number;
  /** Compare: version shown on the left of the divider (null = off). */
  compareVersionId: string | null;
  split: number;
  clip: string | null;
  playing: boolean;
  set(patch: Partial<Omit<ViewerState, "set" | "resetCamera" | "toggle">>): void;
  toggle(key: "turntable" | "showGrid" | "showStats" | "focusMode" | "playing"): void;
  resetCamera(): void;
}

const prefs = loadPrefs();

export const useViewer = create<ViewerState>((set, get) => ({
  lighting: prefs.lighting ?? "studio",
  background: prefs.background ?? "gradient",
  showGrid: prefs.showGrid ?? true,
  showStats: prefs.showStats ?? true,
  renderMode: "textured",
  mapChannel: "baseColor",
  turntable: false,
  focusMode: false,
  frameRequest: 0,
  compareVersionId: null,
  split: 0.5,
  clip: null,
  playing: true,
  set(patch) {
    set(patch);
    const s = get();
    savePrefs({ lighting: s.lighting, background: s.background, showGrid: s.showGrid, showStats: s.showStats });
  },
  toggle(key) {
    get().set({ [key]: !get()[key] } as Partial<ViewerState>);
  },
  resetCamera() {
    set({ frameRequest: get().frameRequest + 1 });
  },
}));
