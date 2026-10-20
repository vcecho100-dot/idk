import type {
  CostEstimate,
  ConnectionTest,
  DroppedItems,
  ExportFile,
  ExportFormat,
  ExportResult,
  GenerateRequest,
  GenerateResult,
  Job,
  JobKind,
  LocalServerProbe,
  NewVersionMeta,
  Project,
  ProjectDetail,
  ProviderId,
  ProviderInfo,
  ProviderUsage,
  RefineRequest,
  RetextureRequest,
  RevealTarget,
  RigRequest,
  Settings,
  StagedImage,
  SystemInfo,
  Theme,
  UpdateChannel,
  UpdateInfo,
  Version,
} from "./types";

export type Unsubscribe = () => void;

export type MediaKind = "png" | "mp4" | "gif";

export type LibraryEvent =
  | { type: "project"; projectId: string }
  | { type: "deleted"; projectId: string }
  | { type: "reset" };

/**
 * Everything the UI can ask of the engine. The desktop implementation calls
 * typed Rust commands; the web implementation runs an in-browser engine for
 * the GitHub Pages demo and for UI development/tests.
 */
export interface Backend {
  readonly kind: "desktop" | "web";

  /* Lifecycle & window */
  /** Reveals the window. `bootError` is reported when the UI failed to start. */
  appReady(bootError?: string): Promise<void>;
  /** Returns true when the native translucent backdrop (Mica) is actually active. */
  setWindowAppearance(theme: Theme, translucent: boolean): Promise<boolean>;

  /* Settings & system */
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetAppData(): Promise<void>;
  systemInfo(): Promise<SystemInfo>;
  openExternal(url: string): Promise<void>;
  checkForUpdates(channel: UpdateChannel): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;

  /* Providers */
  listProviders(): Promise<ProviderInfo[]>;
  setProviderKey(provider: ProviderId, key: string): Promise<void>;
  clearProviderKey(provider: ProviderId): Promise<void>;
  testProvider(provider: ProviderId): Promise<ConnectionTest>;
  providerUsage(): Promise<ProviderUsage[]>;
  probeLocalServer(url: string): Promise<LocalServerProbe>;
  estimateCost(provider: ProviderId, kind: JobKind, req?: Partial<GenerateRequest>): Promise<CostEstimate>;

  /* Jobs */
  generate(req: GenerateRequest): Promise<GenerateResult>;
  refine(req: RefineRequest): Promise<string>;
  retexture(req: RetextureRequest): Promise<string>;
  rig(req: RigRequest): Promise<string>;
  listJobs(): Promise<Job[]>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  dismissJob(id: string): Promise<void>;
  clearFinishedJobs(): Promise<void>;
  onJobUpdate(cb: (job: Job) => void): Unsubscribe;

  /* Library */
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<ProjectDetail>;
  renameProject(id: string, name: string): Promise<Project>;
  setFavorite(id: string, favorite: boolean): Promise<Project>;
  setTags(id: string, tags: string[]): Promise<Project>;
  duplicateProject(id: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  deleteVersion(id: string): Promise<void>;
  setCurrentVersion(projectId: string, versionId: string): Promise<void>;
  createVersion(meta: NewVersionMeta, glb: Uint8Array): Promise<Version>;
  saveThumbnail(versionId: string, image: Uint8Array): Promise<void>;
  onLibraryChanged(cb: (e: LibraryEvent) => void): Unsubscribe;
  /** The version's GLB bytes (desktop streams them over the s3d:// protocol). */
  readModel(versionId: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** A URL for the version's thumbnail image. */
  thumbnailUrl(versionId: string, cacheKey?: string | number): string;

  /* Files */
  pickImages(multiple: boolean): Promise<StagedImage[]>;
  stageImageBytes(name: string, bytes: Uint8Array): Promise<StagedImage>;
  importModel(source: { token: string } | "pick"): Promise<string | null>;
  openProjectFile(source: { token: string } | "pick"): Promise<string | null>;
  saveProjectFile(projectId: string): Promise<ExportResult | null>;
  exportFiles(opts: { suggestedName: string; format: ExportFormat; files: ExportFile[] }): Promise<ExportResult | null>;
  saveMedia(opts: { suggestedName: string; kind: MediaKind; bytes: Uint8Array }): Promise<ExportResult | null>;
  sendToGodot(opts: { name: string; files: ExportFile[] }): Promise<ExportResult>;
  pickGodotProject(): Promise<string | null>;
  pickBlenderPath(): Promise<string | null>;
  pickOutputDir(): Promise<string | null>;
  detectBlender(): Promise<string | null>;
  openInBlender(versionId: string): Promise<void>;
  reveal(target: RevealTarget): Promise<void>;
  onDrop(cb: (items: DroppedItems) => void): Unsubscribe;
  onDragState(cb: (state: "enter" | "leave" | "drop") => void): Unsubscribe;
}
