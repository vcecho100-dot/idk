import type { ProviderCapabilities, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "aurora",
  mica: true,
  reducedMotion: false,
  onboardingDone: false,
  tourDone: false,
  defaultProvider: "mock",
  autoWebFallback: true,
  outputDir: "",
  defaultExportFormat: "glb",
  defaultEnginePreset: "none",
  godotProjectPath: null,
  blenderPath: null,
  viewportQuality: "high",
  fpsCap: 60,
  updateChannel: "stable",
  autoCheckUpdates: true,
  notifications: true,
  localServerUrl: "http://127.0.0.1:8081",
  localServerKind: "hunyuan3d",
  localTexture: false,
};

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  text: true,
  image: true,
  multiview: true,
  refine: true,
  retexture: true,
  rig: true,
  negativePrompt: true,
  faceLimit: true,
  seed: true,
  pbr: true,
};
