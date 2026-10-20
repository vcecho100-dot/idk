import { z } from "zod";

/* ---------------------------------- Enums ---------------------------------- */

export const ProviderIdSchema = z.enum(["mock", "tripo", "meshy", "fal", "local", "hfspace"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const StyleSchema = z.enum(["realistic", "stylized", "cartoon", "lowpoly", "voxel", "sculpture"]);
export type Style = z.infer<typeof StyleSchema>;

export const QualitySchema = z.enum(["draft", "standard", "high"]);
export type Quality = z.infer<typeof QualitySchema>;

export const InputModeSchema = z.enum(["text", "image", "multiview"]);
export type InputMode = z.infer<typeof InputModeSchema>;

export const ViewSlotSchema = z.enum(["front", "side", "back"]);
export type ViewSlot = z.infer<typeof ViewSlotSchema>;

export const JobKindSchema = z.enum(["generate", "refine", "retexture", "rig"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "downloading", "succeeded", "failed", "canceled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const VersionKindSchema = z.enum([
  "generate",
  "refine",
  "retexture",
  "stylize",
  "optimize",
  "transform",
  "material",
  "rig",
  "import",
]);
export type VersionKind = z.infer<typeof VersionKindSchema>;

export const AnimationPresetSchema = z.enum(["idle", "walk", "run"]);
export type AnimationPreset = z.infer<typeof AnimationPresetSchema>;

export const ThemeSchema = z.enum(["dark", "light"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const AccentSchema = z.enum(["aurora", "sunset", "lagoon", "orchid", "ocean", "ember"]);
export type Accent = z.infer<typeof AccentSchema>;

export const ExportFormatSchema = z.enum(["glb", "gltf", "obj", "stl", "usdz"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const EnginePresetSchema = z.enum(["none", "godot", "unity", "unreal", "blender", "print"]);
export type EnginePreset = z.infer<typeof EnginePresetSchema>;

export const ViewportQualitySchema = z.enum(["low", "medium", "high", "ultra"]);
export type ViewportQuality = z.infer<typeof ViewportQualitySchema>;

export const UpdateChannelSchema = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const LocalServerKindSchema = z.enum(["hunyuan3d", "hunyuan3d-gradio", "trellis"]);
export type LocalServerKind = z.infer<typeof LocalServerKindSchema>;

/* ---------------------------------- Errors ---------------------------------- */

export const ErrorCodeSchema = z.enum([
  "offline",
  "network",
  "timeout",
  "auth",
  "rate_limited",
  "credits",
  "provider",
  "validation",
  "not_found",
  "io",
  "cancelled",
  "unsupported",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
});
export type AppErrorShape = z.infer<typeof AppErrorSchema>;

/* --------------------------------- Entities --------------------------------- */

export const ModelStatsSchema = z.object({
  triangles: z.number(),
  vertices: z.number(),
  materials: z.number(),
  textures: z.number(),
  maxTextureSize: z.number(),
  fileSize: z.number(),
  animations: z.array(z.string()),
  hasSkin: z.boolean(),
});
export type ModelStats = z.infer<typeof ModelStatsSchema>;

export const VersionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  kind: VersionKindSchema,
  label: z.string(),
  createdAt: z.string(),
  provider: ProviderIdSchema.nullable(),
  params: z.record(z.string(), z.unknown()),
  stats: ModelStatsSchema.nullable(),
  fileSize: z.number(),
  hasThumbnail: z.boolean(),
  variantGroup: z.string().nullable(),
  variantIndex: z.number().nullable(),
});
export type Version = z.infer<typeof VersionSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  prompt: z.string(),
  style: StyleSchema.nullable(),
  provider: ProviderIdSchema.nullable(),
  currentVersionId: z.string().nullable(),
  thumbnailVersionId: z.string().nullable(),
  versionCount: z.number(),
  sizeBytes: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectDetailSchema = z.object({
  project: ProjectSchema,
  versions: z.array(VersionSchema),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

export const JobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: JobKindSchema,
  provider: ProviderIdSchema,
  status: JobStatusSchema,
  progress: z.number(),
  stage: z.string(),
  title: z.string(),
  variantGroup: z.string().nullable(),
  variantIndex: z.number().nullable(),
  parentVersionId: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  error: AppErrorSchema.nullable(),
  attempts: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const StagedImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  width: z.number(),
  height: z.number(),
  url: z.string(),
});
export type StagedImage = z.infer<typeof StagedImageSchema>;

/* --------------------------------- Requests --------------------------------- */

export interface GenerateRequest {
  projectId?: string;
  parentVersionId?: string;
  mode: InputMode;
  prompt: string;
  negativePrompt?: string;
  images: { imageId: string; view: ViewSlot | null }[];
  style: Style;
  quality: Quality;
  faceLimit?: number;
  pbr: boolean;
  seed?: number;
  variants: 1 | 4;
  provider: ProviderId;
}

export interface GenerateResult {
  projectId: string;
  jobIds: string[];
}

export interface RefineRequest {
  projectId: string;
  versionId: string;
  provider: ProviderId;
}

export interface RetextureRequest {
  projectId: string;
  versionId: string;
  provider: ProviderId;
  prompt: string;
  style: Style;
  pbr: boolean;
}

export interface RigRequest {
  projectId: string;
  versionId: string;
  provider: ProviderId;
  animation: AnimationPreset;
}

export interface NewVersionMeta {
  projectId: string;
  parentId: string | null;
  kind: VersionKind;
  label: string;
  params: Record<string, unknown>;
  stats: ModelStats | null;
}

export const CostEstimateSchema = z.object({
  provider: ProviderIdSchema,
  amount: z.number().nullable(),
  unit: z.enum(["credits", "usd", "free"]),
  label: z.string(),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/* --------------------------------- Providers -------------------------------- */

export const ProviderCapabilitiesSchema = z.object({
  text: z.boolean(),
  image: z.boolean(),
  multiview: z.boolean(),
  refine: z.boolean(),
  retexture: z.boolean(),
  rig: z.boolean(),
  negativePrompt: z.boolean(),
  faceLimit: z.boolean(),
  seed: z.boolean(),
  pbr: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  description: z.string(),
  requiresKey: z.boolean(),
  configured: z.boolean(),
  /** Whether the provider can run right now (key present, server reachable, desktop app…). */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  free: z.boolean(),
  capabilities: ProviderCapabilitiesSchema,
  dashboardUrl: z.string().nullable(),
  docsUrl: z.string().nullable(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ConnectionTestSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nullable(),
  message: z.string(),
  balance: z.string().nullable(),
});
export type ConnectionTest = z.infer<typeof ConnectionTestSchema>;

export const ProviderUsageSchema = z.object({
  provider: ProviderIdSchema,
  jobs: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  creditsSpent: z.number(),
  lastUsedAt: z.string().nullable(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/* --------------------------------- Settings --------------------------------- */

export const SettingsSchema = z.object({
  theme: ThemeSchema,
  accent: AccentSchema,
  mica: z.boolean(),
  reducedMotion: z.boolean(),
  onboardingDone: z.boolean(),
  tourDone: z.boolean(),
  defaultProvider: ProviderIdSchema,
  autoWebFallback: z.boolean(),
  outputDir: z.string(),
  defaultExportFormat: ExportFormatSchema,
  defaultEnginePreset: EnginePresetSchema,
  godotProjectPath: z.string().nullable(),
  blenderPath: z.string().nullable(),
  viewportQuality: ViewportQualitySchema,
  fpsCap: z.number(),
  updateChannel: UpdateChannelSchema,
  autoCheckUpdates: z.boolean(),
  notifications: z.boolean(),
  localServerUrl: z.string(),
  localServerKind: LocalServerKindSchema,
  localTexture: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/* ---------------------------------- System ---------------------------------- */

export const GpuInfoSchema = z.object({
  name: z.string(),
  vramMb: z.number(),
  vendor: z.string(),
});
export type GpuInfo = z.infer<typeof GpuInfoSchema>;

export const SystemInfoSchema = z.object({
  appVersion: z.string(),
  os: z.string(),
  gpus: z.array(GpuInfoSchema),
  dataDir: z.string(),
  libraryDir: z.string(),
  online: z.boolean(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const UpdateInfoSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  date: z.string().nullable(),
});
export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;

export const LocalServerProbeSchema = z.object({
  ok: z.boolean(),
  kind: LocalServerKindSchema.nullable(),
  message: z.string(),
});
export type LocalServerProbe = z.infer<typeof LocalServerProbeSchema>;

/* ---------------------------------- Files ---------------------------------- */

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
}

export const ExportResultSchema = z.object({
  path: z.string(),
  files: z.array(z.string()),
  bytes: z.number(),
});
export type ExportResult = z.infer<typeof ExportResultSchema>;

export const DroppedItemsSchema = z.object({
  images: z.array(StagedImageSchema),
  models: z.array(z.object({ token: z.string(), name: z.string(), size: z.number() })),
  projects: z.array(z.object({ token: z.string(), name: z.string(), size: z.number() })),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type DroppedItems = z.infer<typeof DroppedItemsSchema>;

export type RevealTarget = { kind: "project"; id: string } | { kind: "version"; id: string } | { kind: "path"; path: string };
