import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { z } from "zod";
import type { Backend, LibraryEvent, Unsubscribe } from "./api";
import { BackendError } from "./errors";
import {
  ConnectionTestSchema,
  CostEstimateSchema,
  DroppedItemsSchema,
  ExportResultSchema,
  JobSchema,
  LocalServerProbeSchema,
  ProjectDetailSchema,
  ProjectSchema,
  ProviderInfoSchema,
  ProviderUsageSchema,
  SettingsSchema,
  StagedImageSchema,
  SystemInfoSchema,
  UpdateInfoSchema,
  VersionSchema,
  type ExportFile,
} from "./types";

async function call<T>(cmd: string, schema: z.ZodType<T>, args?: Record<string, unknown>): Promise<T> {
  try {
    const raw = await invoke<unknown>(cmd, args);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[ipc] ${cmd} returned an unexpected shape`, parsed.error);
      throw new BackendError("internal", "The engine returned data the app didn't expect.", "Restart Shift3D. If it persists, reinstall the latest version.");
    }
    return parsed.data;
  } catch (err) {
    throw BackendError.from(err);
  }
}

async function callVoid(cmd: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(cmd, args);
  } catch (err) {
    throw BackendError.from(err);
  }
}

/** Sends a binary payload as the raw IPC body with JSON metadata in a header (no base64/JSON-array overhead). */
async function callBinary<T>(cmd: string, schema: z.ZodType<T>, body: Uint8Array, meta: unknown): Promise<T> {
  try {
    const raw = await invoke<unknown>(cmd, body, { headers: { "x-s3d-meta": encodeURIComponent(JSON.stringify(meta)) } });
    return schema.parse(raw);
  } catch (err) {
    throw BackendError.from(err);
  }
}

/** Packs several files into one body: [u32 count][u32 nameLen][name][u32 len][bytes]... (little-endian). */
export function packFiles(files: ExportFile[]): Uint8Array {
  const enc = new TextEncoder();
  const names = files.map((f) => enc.encode(f.name));
  const total = 4 + files.reduce((sum, f, i) => sum + 8 + names[i]!.length + f.bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, files.length, true);
  o += 4;
  files.forEach((f, i) => {
    const n = names[i]!;
    view.setUint32(o, n.length, true);
    o += 4;
    out.set(n, o);
    o += n.length;
    view.setUint32(o, f.bytes.length, true);
    o += 4;
    out.set(f.bytes, o);
    o += f.bytes.length;
  });
  return out;
}

function subscribe<T>(event: string, schema: z.ZodType<T>, cb: (payload: T) => void): Unsubscribe {
  let disposed = false;
  let un: (() => void) | undefined;
  void listen<unknown>(event, (e) => {
    const parsed = schema.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
    else console.error(`[ipc] bad payload for ${event}`, parsed.error);
  }).then((fn) => {
    if (disposed) fn();
    else un = fn;
  });
  return () => {
    disposed = true;
    un?.();
  };
}

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const PROTOCOL_BASE = isWindows ? "http://s3d.localhost" : "s3d://localhost";

const LibraryEventSchema: z.ZodType<LibraryEvent> = z.union([
  z.object({ type: z.literal("project"), projectId: z.string() }),
  z.object({ type: z.literal("deleted"), projectId: z.string() }),
  z.object({ type: z.literal("reset") }),
]);

const Nullable = <T>(s: z.ZodType<T>) => s.nullable();

export function createDesktopBackend(): Backend {
  return {
    kind: "desktop",

    appReady: (bootError) => callVoid("app_ready", { bootError: bootError ?? null }),
    setWindowAppearance: (theme, translucent) => call("set_window_appearance", z.boolean(), { theme, translucent }),

    getSettings: () => call("get_settings", SettingsSchema),
    updateSettings: (patch) => call("update_settings", SettingsSchema, { patch }),
    resetAppData: () => callVoid("reset_app_data"),
    systemInfo: () => call("system_info", SystemInfoSchema),
    openExternal: (url) => callVoid("open_external", { url }),
    checkForUpdates: (channel) => call("check_for_updates", UpdateInfoSchema, { channel }),
    installUpdate: () => callVoid("install_update"),

    listProviders: () => call("list_providers", z.array(ProviderInfoSchema)),
    setProviderKey: (provider, key) => callVoid("set_provider_key", { provider, key }),
    clearProviderKey: (provider) => callVoid("clear_provider_key", { provider }),
    testProvider: (provider) => call("test_provider", ConnectionTestSchema, { provider }),
    providerUsage: () => call("provider_usage", z.array(ProviderUsageSchema)),
    probeLocalServer: (url) => call("probe_local_server", LocalServerProbeSchema, { url }),
    estimateCost: (provider, kind, req) => call("estimate_cost", CostEstimateSchema, { provider, kind, req: req ?? null }),

    generate: (req) => call("generate", z.object({ projectId: z.string(), jobIds: z.array(z.string()) }), { req }),
    refine: (req) => call("refine", z.string(), { req }),
    retexture: (req) => call("retexture", z.string(), { req }),
    rig: (req) => call("rig", z.string(), { req }),
    listJobs: () => call("list_jobs", z.array(JobSchema)),
    cancelJob: (id) => callVoid("cancel_job", { id }),
    retryJob: (id) => callVoid("retry_job", { id }),
    dismissJob: (id) => callVoid("dismiss_job", { id }),
    clearFinishedJobs: () => callVoid("clear_finished_jobs"),
    onJobUpdate: (cb) => subscribe("jobs://update", JobSchema, cb),

    listProjects: () => call("list_projects", z.array(ProjectSchema)),
    getProject: (id) => call("get_project", ProjectDetailSchema, { id }),
    renameProject: (id, name) => call("rename_project", ProjectSchema, { id, name }),
    setFavorite: (id, favorite) => call("set_favorite", ProjectSchema, { id, favorite }),
    setTags: (id, tags) => call("set_tags", ProjectSchema, { id, tags }),
    duplicateProject: (id) => call("duplicate_project", ProjectSchema, { id }),
    deleteProject: (id) => callVoid("delete_project", { id }),
    deleteVersion: (id) => callVoid("delete_version", { id }),
    setCurrentVersion: (projectId, versionId) => callVoid("set_current_version", { projectId, versionId }),
    createVersion: (meta, glb) => callBinary("create_version", VersionSchema, glb, meta),
    saveThumbnail: (versionId, image) => callBinary("save_thumbnail", z.null(), image, { versionId }).then(() => undefined),
    onLibraryChanged: (cb) => subscribe("library://changed", LibraryEventSchema, cb),
    readModel: async (versionId, signal) => {
      const res = await fetch(`${PROTOCOL_BASE}/model/${encodeURIComponent(versionId)}.glb`, { signal });
      if (!res.ok) {
        throw new BackendError("not_found", "This version's model file is missing.", "It may have been deleted outside Shift3D. Pick another version.");
      }
      return res.arrayBuffer();
    },
    thumbnailUrl: (versionId, cacheKey) =>
      `${PROTOCOL_BASE}/thumb/${encodeURIComponent(versionId)}.webp${cacheKey !== undefined ? `?v=${cacheKey}` : ""}`,

    pickImages: (multiple) => call("pick_images", z.array(StagedImageSchema), { multiple }),
    stageImageBytes: (name, bytes) => callBinary("stage_image_bytes", StagedImageSchema, bytes, { name }),
    importModel: (source) => call("import_model", Nullable(z.string()), { token: source === "pick" ? null : source.token }),
    openProjectFile: (source) => call("open_project_file", Nullable(z.string()), { token: source === "pick" ? null : source.token }),
    saveProjectFile: (projectId) => call("save_project_file", Nullable(ExportResultSchema), { projectId }),
    exportFiles: ({ suggestedName, format, files }) =>
      callBinary("export_files", Nullable(ExportResultSchema), packFiles(files), { suggestedName, format }),
    saveMedia: ({ suggestedName, kind, bytes }) =>
      callBinary("save_media", Nullable(ExportResultSchema), bytes, { suggestedName, kind }),
    sendToGodot: ({ name, files }) => callBinary("send_to_godot", ExportResultSchema, packFiles(files), { name }),
    pickGodotProject: () => call("pick_godot_project", Nullable(z.string())),
    pickBlenderPath: () => call("pick_blender_path", Nullable(z.string())),
    pickOutputDir: () => call("pick_output_dir", Nullable(z.string())),
    detectBlender: () => call("detect_blender", Nullable(z.string())),
    openInBlender: (versionId) => callVoid("open_in_blender", { versionId }),
    reveal: (target) => callVoid("reveal", { target }),
    onDrop: (cb) => subscribe("app://dropped", DroppedItemsSchema, cb),
    onDragState: (cb) => {
      let un: (() => void) | undefined;
      let disposed = false;
      void getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type === "enter" || e.payload.type === "over") cb("enter");
          else if (e.payload.type === "leave") cb("leave");
          else if (e.payload.type === "drop") cb("drop");
        })
        .then((fn) => {
          if (disposed) fn();
          else un = fn;
        });
      return () => {
        disposed = true;
        un?.();
      };
    },
  };
}
