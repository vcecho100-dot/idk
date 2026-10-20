/**
 * The in-browser engine: powers the GitHub Pages web demo and UI development.
 * It mirrors the desktop engine's behaviour in offline mock mode — staged job
 * progress, keyword-matched sample models, variants, refine/retexture/rig — and
 * persists the library in IndexedDB. Provider keys never exist in the browser.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Backend, LibraryEvent, MediaKind, Unsubscribe } from "../api";
import { DEFAULT_SETTINGS, MOCK_CAPABILITIES } from "../defaults";
import { BackendError } from "../errors";
import {
  ProjectSchema,
  SettingsSchema,
  VersionSchema,
  type AnimationPreset,
  type DroppedItems,
  type ExportFile,
  type Job,
  type JobKind,
  type NewVersionMeta,
  type Project,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderInfo,
  type Quality,
  type Settings,
  type StagedImage,
  type Version,
} from "../types";
import { indexedKV, type KV } from "./store";
import {
  GENERATE_STAGES,
  REFINE_STAGES,
  RETEXTURE_STAGES,
  RIG_STAGES,
  VARIANT_TINTS,
  materialEditFromPrompt,
  pickSample,
  stageAt,
  type Catalog,
  type MockStage,
  type SampleEntry,
} from "@/lib/engine/catalog";
import { applyMaterialEdit, computeStats, draftGlb, imageSize, isGlb, tintGlb } from "@/lib/gltf/glb";
import { nameFromPrompt, uid } from "@/lib/utils";
import { APP_VERSION } from "@/lib/platform";

const SETTINGS_KEY = "shift3d.settings";
const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CONCURRENT = 2;

interface JobSpec {
  kind: JobKind;
  sampleId: string | null;
  sourceVersionId: string | null;
  quality: Quality;
  variantIndex: number;
  prompt: string;
  animation: AnimationPreset | null;
}

interface StoredJob {
  job: Job;
  spec: JobSpec;
}

export interface WebBackendOptions {
  kv?: KV;
  /** Loads a sample file; defaults to fetching from /samples. */
  loadSample?: (file: string) => Promise<Uint8Array>;
  /** Multiplies mock job durations (tests use a tiny value). */
  timeScale?: number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const nowIso = () => new Date().toISOString();

function unsupported(feature: string): BackendError {
  return new BackendError("unsupported", `${feature} is only available in the Shift3D desktop app.`, "Download the Windows app from the GitHub releases page.");
}

function webProviders(): ProviderInfo[] {
  const none: ProviderCapabilities = { ...MOCK_CAPABILITIES, text: false, image: false, multiview: false, refine: false, retexture: false, rig: false };
  const desktopOnly = "Desktop app only — API keys are stored in Windows Credential Manager, never in a browser.";
  return [
    {
      id: "mock",
      name: "Offline demo",
      description: "Simulated generation with bundled sample models. No account, no internet.",
      requiresKey: false,
      configured: true,
      available: true,
      unavailableReason: null,
      free: true,
      capabilities: MOCK_CAPABILITIES,
      dashboardUrl: null,
      docsUrl: null,
    },
    ...(
      [
        ["tripo", "Tripo", "Fast, high-quality text & image to 3D with rigging.", "https://platform.tripo3d.ai/", "https://platform.tripo3d.ai/docs"],
        ["meshy", "Meshy", "Text, image & multi-image to 3D with retexturing.", "https://www.meshy.ai/settings/api", "https://docs.meshy.ai/"],
        ["fal", "fal.ai", "TRELLIS and Hunyuan3D on serverless GPUs.", "https://fal.ai/dashboard/keys", "https://fal.ai/models"],
        ["local", "Local GPU", "Self-hosted Hunyuan3D or TRELLIS — 100% private.", null, null],
        ["hfspace", "Hugging Face (free)", "Free public Spaces — slower, shared GPUs.", null, null],
      ] as const
    ).map(([id, name, description, dashboardUrl, docsUrl]) => ({
      id,
      name,
      description,
      requiresKey: id === "tripo" || id === "meshy" || id === "fal",
      configured: false,
      available: false,
      unavailableReason: desktopOnly,
      free: id === "local" || id === "hfspace",
      capabilities: none,
      dashboardUrl,
      docsUrl,
    })),
  ];
}

function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

const MIME: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  stl: "model/stl",
  usdz: "model/vnd.usdz+zip",
  png: "image/png",
  mp4: "video/mp4",
  gif: "image/gif",
  zip: "application/zip",
};

function isImageBytes(b: Uint8Array): boolean {
  return imageSize(b) !== null;
}

export async function createWebBackend(opts: WebBackendOptions = {}): Promise<Backend> {
  const kv = opts.kv ?? (await indexedKV());
  const storage = opts.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const timeScale = opts.timeScale ?? 1;
  const base = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  const loadSample =
    opts.loadSample ??
    (async (file: string) => {
      const res = await fetch(`${base}samples/${file}`);
      if (!res.ok) throw new BackendError("not_found", `Sample model ${file} is missing.`);
      return new Uint8Array(await res.arrayBuffer());
    });

  /* -------------------------------- State -------------------------------- */

  const projects = new Map<string, Project>();
  const versions = new Map<string, Version>();
  const jobs = new Map<string, StoredJob>();
  const thumbs = new Map<string, string>();
  const staged = new Map<string, { bytes: Uint8Array; image: StagedImage }>();
  const droppedFiles = new Map<string, File>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const jobListeners = new Set<(j: Job) => void>();
  const libListeners = new Set<(e: LibraryEvent) => void>();
  const dropListeners = new Set<(d: DroppedItems) => void>();
  const dragListeners = new Set<(s: "enter" | "leave" | "drop") => void>();
  let catalog: Catalog | null = null;

  for (const p of await kv.all<Project>("projects")) {
    const parsed = ProjectSchema.safeParse(p);
    if (parsed.success) projects.set(parsed.data.id, parsed.data);
  }
  for (const v of await kv.all<Version>("versions")) {
    const parsed = VersionSchema.safeParse(v);
    if (parsed.success) versions.set(parsed.data.id, parsed.data);
  }
  for (const sj of await kv.all<StoredJob>("jobs")) jobs.set(sj.job.id, sj);
  for (const v of versions.values()) {
    if (!v.hasThumbnail) continue;
    const blob = await kv.get<Uint8Array>("blobs", `thumb:${v.id}`);
    if (blob) thumbs.set(v.id, URL.createObjectURL(new Blob([blob as BlobPart], { type: "image/webp" })));
  }

  const emitJob = (j: Job) => jobListeners.forEach((cb) => cb(j));
  const emitLib = (e: LibraryEvent) => libListeners.forEach((cb) => cb(e));

  async function getCatalog(): Promise<Catalog> {
    if (catalog) return catalog;
    const bytes = await loadSample("catalog.json");
    catalog = JSON.parse(new TextDecoder().decode(bytes)) as Catalog;
    return catalog;
  }

  function readSettings(): Settings {
    try {
      const raw = storage?.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = SettingsSchema.partial().safeParse(JSON.parse(raw));
        if (parsed.success) return { ...DEFAULT_SETTINGS, outputDir: "Downloads", ...parsed.data };
      }
    } catch {
      /* fall through to defaults */
    }
    return { ...DEFAULT_SETTINGS, outputDir: "Downloads" };
  }

  async function saveProject(p: Project): Promise<Project> {
    projects.set(p.id, p);
    await kv.put("projects", p.id, p);
    return p;
  }

  async function saveJob(sj: StoredJob): Promise<void> {
    jobs.set(sj.job.id, sj);
    await kv.put("jobs", sj.job.id, sj);
    emitJob(sj.job);
  }

  function requireProject(id: string): Project {
    const p = projects.get(id);
    if (!p) throw new BackendError("not_found", "That project no longer exists.", "It may have been deleted. Open another one from the Library.");
    return p;
  }

  function requireVersion(id: string): Version {
    const v = versions.get(id);
    if (!v) throw new BackendError("not_found", "That version no longer exists.");
    return v;
  }

  async function modelBytes(versionId: string): Promise<Uint8Array> {
    const b = await kv.get<Uint8Array>("blobs", `model:${versionId}`);
    if (!b) throw new BackendError("not_found", "This version's model file is missing.", "Pick another version.");
    return b;
  }

  async function createProject(name: string, prompt: string, extra: Partial<Project> = {}): Promise<Project> {
    const t = nowIso();
    return saveProject({
      id: uid("p_"),
      name,
      createdAt: t,
      updatedAt: t,
      favorite: false,
      tags: [],
      prompt,
      style: null,
      provider: null,
      currentVersionId: null,
      thumbnailVersionId: null,
      versionCount: 0,
      sizeBytes: 0,
      ...extra,
    });
  }

  async function addVersion(
    meta: NewVersionMeta,
    bytes: Uint8Array,
    extra: { provider?: ProviderId | null; variantGroup?: string | null; variantIndex?: number | null; makeCurrent?: boolean } = {},
  ): Promise<Version> {
    if (!isGlb(bytes)) throw new BackendError("validation", "That isn't a valid GLB model.");
    if (bytes.length > MAX_MODEL_BYTES) throw new BackendError("validation", "That model is larger than 256 MB.");
    const project = requireProject(meta.projectId);
    const stats = meta.stats ?? computeStats(bytes);
    const v: Version = {
      id: uid("v_"),
      projectId: meta.projectId,
      parentId: meta.parentId,
      kind: meta.kind,
      label: meta.label,
      createdAt: nowIso(),
      provider: extra.provider ?? null,
      params: meta.params,
      stats: { ...stats, fileSize: bytes.length },
      fileSize: bytes.length,
      hasThumbnail: false,
      variantGroup: extra.variantGroup ?? null,
      variantIndex: extra.variantIndex ?? null,
    };
    await kv.put("blobs", `model:${v.id}`, bytes);
    versions.set(v.id, v);
    await kv.put("versions", v.id, v);
    const makeCurrent = extra.makeCurrent ?? true;
    await saveProject({
      ...project,
      versionCount: project.versionCount + 1,
      sizeBytes: project.sizeBytes + bytes.length,
      updatedAt: v.createdAt,
      currentVersionId: makeCurrent ? v.id : project.currentVersionId ?? v.id,
    });
    emitLib({ type: "project", projectId: project.id });
    return v;
  }

  /** Walks up the version tree to find the sample a mock model came from. */
  function sampleAncestor(versionId: string | null): string | null {
    let cur = versionId ? versions.get(versionId) : undefined;
    for (let i = 0; cur && i < 64; i++) {
      const id = cur.params.sampleId;
      if (typeof id === "string") return id;
      cur = cur.parentId ? versions.get(cur.parentId) : undefined;
    }
    return null;
  }

  /* -------------------------------- Jobs -------------------------------- */

  const STAGES: Record<JobKind, MockStage[]> = { generate: GENERATE_STAGES, refine: REFINE_STAGES, retexture: RETEXTURE_STAGES, rig: RIG_STAGES };
  const DURATION: Record<JobKind, number> = { generate: 8000, refine: 6500, retexture: 5500, rig: 5000 };

  function runningCount(): number {
    return [...jobs.values()].filter((j) => j.job.status === "running" || j.job.status === "downloading").length;
  }

  function pump(): void {
    const queued = [...jobs.values()].filter((j) => j.job.status === "queued").sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
    for (const sj of queued) {
      if (runningCount() >= MAX_CONCURRENT) break;
      startJob(sj);
    }
  }

  function startJob(sj: StoredJob): void {
    const total = DURATION[sj.spec.kind] * timeScale * (0.9 + Math.random() * 0.25);
    const started = performance.now();
    sj.job = { ...sj.job, status: "running", progress: 0, stage: STAGES[sj.spec.kind][0]!.label, startedAt: nowIso(), updatedAt: nowIso(), attempts: sj.job.attempts + 1, error: null };
    void saveJob(sj);
    const tick = setInterval(
      () => {
        const t = Math.min(1, (performance.now() - started) / total);
        // Ease-out with small stalls near stage boundaries feels like a real backend.
        const p = Math.min(0.999, 1 - Math.pow(1 - t, 1.7));
        const status = p > 0.93 ? "downloading" : "running";
        sj.job = { ...sj.job, progress: p, stage: stageAt(STAGES[sj.spec.kind], p), status, updatedAt: nowIso() };
        jobs.set(sj.job.id, sj);
        emitJob(sj.job);
        if (t >= 1) {
          clearInterval(tick);
          timers.delete(sj.job.id);
          void finishJob(sj);
        }
      },
      Math.max(16, 120 * Math.min(1, timeScale * 4)),
    );
    timers.set(sj.job.id, tick);
  }

  async function finishJob(sj: StoredJob): Promise<void> {
    const current = jobs.get(sj.job.id);
    if (!current || current.job.status === "canceled") return;
    try {
      const version = await produceResult(sj);
      sj.job = { ...sj.job, status: "succeeded", progress: 1, stage: "Done", resultVersionId: version.id, finishedAt: nowIso(), updatedAt: nowIso() };
    } catch (err) {
      const e = BackendError.from(err);
      sj.job = { ...sj.job, status: "failed", stage: "Failed", error: { code: e.code, message: e.message, hint: e.hint }, finishedAt: nowIso(), updatedAt: nowIso() };
    }
    await saveJob(sj);
    pump();
  }

  async function produceResult(sj: StoredJob): Promise<Version> {
    const cat = await getCatalog();
    const { spec, job } = sj;
    const project = requireProject(job.projectId);
    const sample = (id: string | null): SampleEntry => {
      const s = cat.samples.find((x) => x.id === id);
      if (!s) throw new BackendError("not_found", "The sample model for this project is missing.");
      return s;
    };

    if (spec.kind === "generate") {
      const s = sample(spec.sampleId);
      let bytes = await loadSample(s.file);
      const tint = VARIANT_TINTS[spec.variantIndex % VARIANT_TINTS.length]!;
      if (spec.variantIndex > 0) bytes = tintGlb(bytes, tint, 0.85);
      if (spec.quality === "draft") bytes = draftGlb(bytes);
      const variants = job.variantGroup !== null;
      return addVersion(
        {
          projectId: project.id,
          parentId: job.parentVersionId,
          kind: "generate",
          label: variants ? `Variant ${spec.variantIndex + 1}` : spec.quality === "draft" ? "Draft" : "Generated",
          params: { prompt: spec.prompt, sampleId: s.id, quality: spec.quality, variant: spec.variantIndex },
          stats: null,
        },
        bytes,
        { provider: "mock", variantGroup: job.variantGroup, variantIndex: job.variantIndex, makeCurrent: !variants || spec.variantIndex === 0 },
      );
    }

    if (spec.kind === "refine") {
      const sampleId = sampleAncestor(spec.sourceVersionId);
      if (!sampleId) {
        throw new BackendError("unsupported", "The offline demo can only refine models it generated.", "Connect Tripo or Meshy in Settings to refine any model.");
      }
      const s = sample(sampleId);
      const source = requireVersion(spec.sourceVersionId!);
      let bytes = await loadSample(s.file);
      const variant = Number(source.params.variant ?? 0);
      if (variant > 0) bytes = tintGlb(bytes, VARIANT_TINTS[variant % VARIANT_TINTS.length]!, 0.85);
      return addVersion(
        { projectId: project.id, parentId: source.id, kind: "refine", label: "Refined · HQ", params: { sampleId: s.id, variant, quality: "high" }, stats: null },
        bytes,
        { provider: "mock" },
      );
    }

    if (spec.kind === "retexture") {
      const source = requireVersion(spec.sourceVersionId!);
      const edit = materialEditFromPrompt(spec.prompt);
      const bytes = applyMaterialEdit(await modelBytes(source.id), edit);
      return addVersion(
        { projectId: project.id, parentId: source.id, kind: "retexture", label: "Retextured", params: { texturePrompt: spec.prompt, matched: edit.matched }, stats: null },
        bytes,
        { provider: "mock" },
      );
    }

    // rig
    const sampleId = sampleAncestor(spec.sourceVersionId);
    const s = sampleId ? cat.samples.find((x) => x.id === sampleId) : undefined;
    if (!s?.rigged) {
      throw new BackendError(
        "unsupported",
        "The offline demo can only rig its humanoid and quadruped samples.",
        "Try a prompt like “a knight” or “a fox”, or connect Tripo or Meshy to rig any model.",
      );
    }
    const source = requireVersion(spec.sourceVersionId!);
    const clip = s.animationMap?.[spec.animation ?? "idle"] ?? "*";
    return addVersion(
      {
        projectId: project.id,
        parentId: source.id,
        kind: "rig",
        label: `Rigged · ${spec.animation ?? "idle"}`,
        params: { sampleId: s.id, animation: spec.animation, clip },
        stats: null,
      },
      await loadSample(s.file),
      { provider: "mock" },
    );
  }

  async function enqueue(projectId: string, title: string, spec: JobSpec, extra: Partial<Job> = {}): Promise<string> {
    const t = nowIso();
    const job: Job = {
      id: uid("j_"),
      projectId,
      kind: spec.kind,
      provider: "mock",
      status: "queued",
      progress: 0,
      stage: "Waiting in queue",
      title,
      variantGroup: null,
      variantIndex: null,
      parentVersionId: spec.sourceVersionId,
      resultVersionId: null,
      error: null,
      attempts: 0,
      createdAt: t,
      updatedAt: t,
      startedAt: null,
      finishedAt: null,
      ...extra,
    };
    await saveJob({ job, spec });
    pump();
    return job.id;
  }

  function requireMock(provider: ProviderId): void {
    if (provider !== "mock") throw unsupported("Cloud and local providers are");
  }

  // Jobs that were running when the page closed resume from the start.
  for (const sj of jobs.values()) {
    if (sj.job.status === "running" || sj.job.status === "downloading") {
      sj.job = { ...sj.job, status: "queued", stage: "Resuming…", progress: 0 };
    }
  }
  setTimeout(pump, 0);

  /* ------------------------------ Drag & drop ------------------------------ */

  async function stage(name: string, bytes: Uint8Array): Promise<StagedImage> {
    if (bytes.length > MAX_IMAGE_BYTES) throw new BackendError("validation", `${name} is larger than 20 MB.`, "Use a smaller PNG, JPEG or WebP image.");
    const size = imageSize(bytes);
    if (!size) throw new BackendError("validation", `${name} isn't a PNG, JPEG or WebP image.`);
    const id = uid("img_");
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const image: StagedImage = { id, name, size: bytes.length, width: size.width, height: size.height, url };
    staged.set(id, { bytes, image });
    return image;
  }

  async function classify(files: File[]): Promise<DroppedItems> {
    const out: DroppedItems = { images: [], models: [], projects: [], rejected: [] };
    for (const f of files) {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      try {
        if (["png", "jpg", "jpeg", "webp"].includes(ext)) out.images.push(await stage(f.name, new Uint8Array(await f.arrayBuffer())));
        else if (ext === "glb" || ext === "gltf") {
          const token = uid("drop_");
          droppedFiles.set(token, f);
          out.models.push({ token, name: f.name, size: f.size });
        } else if (ext === "shift3d") {
          const token = uid("drop_");
          droppedFiles.set(token, f);
          out.projects.push({ token, name: f.name, size: f.size });
        } else out.rejected.push({ name: f.name, reason: "Unsupported file type" });
      } catch (err) {
        out.rejected.push({ name: f.name, reason: BackendError.from(err).message });
      }
    }
    return out;
  }

  if (typeof window !== "undefined") {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth++;
      dragListeners.forEach((cb) => cb("enter"));
    });
    window.addEventListener("dragover", (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) dragListeners.forEach((cb) => cb("leave"));
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dragListeners.forEach((cb) => cb("drop"));
      void classify(Array.from(e.dataTransfer?.files ?? [])).then((items) => dropListeners.forEach((cb) => cb(items)));
    });
  }

  async function importGlbBytes(name: string, bytes: Uint8Array): Promise<string> {
    let glb = bytes;
    if (!isGlb(glb)) {
      // A self-contained .gltf (data: URIs) can be converted in the browser.
      const { WebIO } = await import("@gltf-transform/core");
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
        const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((r) => r.uri && !r.uri.startsWith("data:"));
        if (external) {
          throw new BackendError("unsupported", `${name} references external files.`, "Drop the .glb version instead, or use the desktop app which reads sibling files.");
        }
        const doc = await new WebIO().readJSON({ json: json as never, resources: {} });
        glb = await new WebIO().writeBinary(doc);
      } catch (err) {
        if (err instanceof BackendError) throw err;
        throw new BackendError("validation", `${name} isn't a valid glTF or GLB file.`);
      }
    }
    const project = await createProject(name.replace(/\.(glb|gltf)$/i, ""), "", { provider: null });
    await addVersion({ projectId: project.id, parentId: null, kind: "import", label: "Imported", params: { file: name }, stats: null }, glb);
    return project.id;
  }

  async function importShift3d(bytes: Uint8Array): Promise<string> {
    let files: Record<string, Uint8Array>;
    try {
      let total = 0;
      files = unzipSync(bytes, {
        filter: (f) => {
          total += f.originalSize;
          if (total > 1024 * 1024 * 1024) throw new BackendError("validation", "This project file expands to more than 1 GB.", "It may be corrupted or malicious.");
          return f.name === "project.json" || /^versions\/[\w-]+\.glb$/.test(f.name) || /^thumbs\/[\w-]+\.webp$/.test(f.name);
        },
      });
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError("validation", "That isn't a valid .shift3d project file.");
    }
    const manifest = files["project.json"];
    if (!manifest) throw new BackendError("validation", "The project file has no manifest.");
    const data = JSON.parse(strFromU8(manifest)) as { project: Project; versions: Version[] };
    const project = await createProject(data.project.name, data.project.prompt, { style: data.project.style, provider: data.project.provider, tags: data.project.tags });
    const idMap = new Map<string, string>();
    const ordered = [...data.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const v of ordered) {
      const glb = files[`versions/${v.id}.glb`];
      if (!glb) continue;
      const created = await addVersion(
        { projectId: project.id, parentId: v.parentId ? idMap.get(v.parentId) ?? null : null, kind: v.kind, label: v.label, params: v.params, stats: v.stats },
        glb,
        { provider: v.provider, makeCurrent: v.id === data.project.currentVersionId },
      );
      idMap.set(v.id, created.id);
      const thumb = files[`thumbs/${v.id}.webp`];
      if (thumb) await api.saveThumbnail(created.id, thumb);
    }
    return project.id;
  }

  /* ---------------------------------- API ---------------------------------- */

  const api: Backend = {
    kind: "web",

    appReady: async () => {},
    setWindowAppearance: async () => false,

    getSettings: async () => readSettings(),
    updateSettings: async (patch) => {
      const next = SettingsSchema.parse({ ...readSettings(), ...patch });
      storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    },
    resetAppData: async () => {
      timers.forEach((t) => clearInterval(t));
      timers.clear();
      await kv.clear();
      projects.clear();
      versions.clear();
      jobs.clear();
      thumbs.forEach((u) => URL.revokeObjectURL(u));
      thumbs.clear();
      storage?.removeItem(SETTINGS_KEY);
      storage?.removeItem("shift3d.appearance");
      emitLib({ type: "reset" });
    },
    systemInfo: async () => {
      let gpu = "Unknown GPU";
      try {
        const gl = document.createElement("canvas").getContext("webgl2");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      } catch {
        /* ignore */
      }
      return {
        appVersion: APP_VERSION,
        os: navigator.userAgent.includes("Windows") ? "Windows (browser)" : "Web browser",
        gpus: [{ name: gpu, vramMb: 0, vendor: "" }],
        dataDir: "Browser storage (IndexedDB)",
        libraryDir: "Browser storage (IndexedDB)",
        online: navigator.onLine,
      };
    },
    openExternal: async (url) => {
      if (!/^https:\/\//.test(url)) throw new BackendError("validation", "Only https links can be opened.");
      window.open(url, "_blank", "noopener,noreferrer");
    },
    checkForUpdates: async () => ({ available: false, version: null, notes: null, date: null }),
    installUpdate: async () => {
      throw unsupported("Auto-update");
    },

    listProviders: async () => webProviders(),
    setProviderKey: async () => {
      throw unsupported("Saving API keys");
    },
    clearProviderKey: async () => {
      throw unsupported("API keys are");
    },
    testProvider: async (provider) => {
      if (provider === "mock") return { ok: true, latencyMs: 0, message: "The offline demo is always available.", balance: null };
      throw unsupported("Provider connections are");
    },
    providerUsage: async () => {
      const all = [...jobs.values()].map((j) => j.job);
      const mockJobs = all.filter((j) => j.provider === "mock");
      return [
        {
          provider: "mock",
          jobs: mockJobs.length,
          succeeded: mockJobs.filter((j) => j.status === "succeeded").length,
          failed: mockJobs.filter((j) => j.status === "failed").length,
          creditsSpent: 0,
          lastUsedAt: mockJobs.map((j) => j.createdAt).sort().pop() ?? null,
        },
      ];
    },
    probeLocalServer: async () => {
      throw unsupported("Local GPU servers are");
    },
    estimateCost: async (provider) => {
      requireMock(provider);
      return { provider, amount: null, unit: "free", label: "Free · offline demo" };
    },

    generate: async (req) => {
      requireMock(req.provider);
      if (req.mode === "text" && !req.prompt.trim()) throw new BackendError("validation", "Describe what you want to make first.");
      if (req.mode !== "text" && req.images.length === 0) throw new BackendError("validation", "Add an image first.", "Drop a PNG, JPEG or WebP onto the window, or click to browse.");
      const cat = await getCatalog();
      const imageNames = req.images.map((i) => staged.get(i.imageId)?.image.name ?? "").join(" ");
      const sample = pickSample(cat, `${req.prompt} ${imageNames}`);
      const title = req.prompt.trim() || imageNames.replace(/\.(png|jpe?g|webp)/gi, "") || sample.name;
      const project = req.projectId
        ? requireProject(req.projectId)
        : await createProject(nameFromPrompt(req.prompt, sample.name), req.prompt, { style: req.style, provider: req.provider });
      if (req.projectId) await saveProject({ ...project, prompt: req.prompt || project.prompt, style: req.style, provider: req.provider });
      const group = req.variants > 1 ? uid("g_") : null;
      const jobIds: string[] = [];
      for (let i = 0; i < req.variants; i++) {
        jobIds.push(
          await enqueue(
            project.id,
            req.variants > 1 ? `${title} · variant ${i + 1}` : title,
            { kind: "generate", sampleId: sample.id, sourceVersionId: req.parentVersionId ?? null, quality: req.quality, variantIndex: i, prompt: req.prompt, animation: null },
            { variantGroup: group, variantIndex: group ? i : null, parentVersionId: req.parentVersionId ?? null },
          ),
        );
      }
      emitLib({ type: "project", projectId: project.id });
      return { projectId: project.id, jobIds };
    },
    refine: async (req) => {
      requireMock(req.provider);
      const v = requireVersion(req.versionId);
      return enqueue(req.projectId, `Refine · ${v.label}`, { kind: "refine", sampleId: null, sourceVersionId: v.id, quality: "high", variantIndex: 0, prompt: "", animation: null });
    },
    retexture: async (req) => {
      requireMock(req.provider);
      if (!req.prompt.trim()) throw new BackendError("validation", "Describe the new texture first.");
      const v = requireVersion(req.versionId);
      return enqueue(req.projectId, `Retexture · ${req.prompt}`, { kind: "retexture", sampleId: null, sourceVersionId: v.id, quality: "standard", variantIndex: 0, prompt: req.prompt, animation: null });
    },
    rig: async (req) => {
      requireMock(req.provider);
      const v = requireVersion(req.versionId);
      return enqueue(req.projectId, `Rig · ${req.animation}`, { kind: "rig", sampleId: null, sourceVersionId: v.id, quality: "standard", variantIndex: 0, prompt: "", animation: req.animation });
    },
    listJobs: async () => [...jobs.values()].map((j) => j.job).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    cancelJob: async (id) => {
      const sj = jobs.get(id);
      if (!sj || ["succeeded", "failed", "canceled"].includes(sj.job.status)) return;
      const t = timers.get(id);
      if (t) clearInterval(t);
      timers.delete(id);
      sj.job = { ...sj.job, status: "canceled", stage: "Canceled", finishedAt: nowIso(), updatedAt: nowIso() };
      await saveJob(sj);
      pump();
    },
    retryJob: async (id) => {
      const sj = jobs.get(id);
      if (!sj || !["failed", "canceled"].includes(sj.job.status)) return;
      sj.job = { ...sj.job, status: "queued", progress: 0, stage: "Waiting in queue", error: null, finishedAt: null, updatedAt: nowIso() };
      await saveJob(sj);
      pump();
    },
    dismissJob: async (id) => {
      const sj = jobs.get(id);
      if (!sj) return;
      if (sj.job.status === "running" || sj.job.status === "queued" || sj.job.status === "downloading") await api.cancelJob(id);
      jobs.delete(id);
      await kv.del("jobs", id);
    },
    clearFinishedJobs: async () => {
      for (const sj of [...jobs.values()]) {
        if (["succeeded", "failed", "canceled"].includes(sj.job.status)) {
          jobs.delete(sj.job.id);
          await kv.del("jobs", sj.job.id);
        }
      }
    },
    onJobUpdate: (cb) => {
      jobListeners.add(cb);
      return () => jobListeners.delete(cb);
    },

    listProjects: async () =>
      [...projects.values()].filter((p) => p.versionCount > 0 || [...jobs.values()].some((j) => j.job.projectId === p.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    getProject: async (id) => ({
      project: requireProject(id),
      versions: [...versions.values()].filter((v) => v.projectId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }),
    renameProject: async (id, name) => {
      const trimmed = name.trim().slice(0, 120);
      if (!trimmed) throw new BackendError("validation", "Project names can't be empty.");
      const p = await saveProject({ ...requireProject(id), name: trimmed, updatedAt: nowIso() });
      emitLib({ type: "project", projectId: id });
      return p;
    },
    setFavorite: async (id, favorite) => {
      const p = await saveProject({ ...requireProject(id), favorite });
      emitLib({ type: "project", projectId: id });
      return p;
    },
    setTags: async (id, tags) => {
      const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
      const p = await saveProject({ ...requireProject(id), tags: clean });
      emitLib({ type: "project", projectId: id });
      return p;
    },
    duplicateProject: async (id) => {
      const src = requireProject(id);
      const copy = await createProject(`${src.name} copy`, src.prompt, { style: src.style, provider: src.provider, tags: src.tags });
      const idMap = new Map<string, string>();
      const list = [...versions.values()].filter((v) => v.projectId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const v of list) {
        const created = await addVersion(
          { projectId: copy.id, parentId: v.parentId ? idMap.get(v.parentId) ?? null : null, kind: v.kind, label: v.label, params: v.params, stats: v.stats },
          await modelBytes(v.id),
          { provider: v.provider, variantGroup: v.variantGroup, variantIndex: v.variantIndex, makeCurrent: v.id === src.currentVersionId },
        );
        idMap.set(v.id, created.id);
        const thumb = await kv.get<Uint8Array>("blobs", `thumb:${v.id}`);
        if (thumb) await api.saveThumbnail(created.id, thumb);
      }
      return requireProject(copy.id);
    },
    deleteProject: async (id) => {
      requireProject(id);
      for (const v of [...versions.values()].filter((x) => x.projectId === id)) {
        versions.delete(v.id);
        await kv.del("versions", v.id);
        await kv.del("blobs", `model:${v.id}`);
        await kv.del("blobs", `thumb:${v.id}`);
      }
      for (const sj of [...jobs.values()].filter((j) => j.job.projectId === id)) await api.dismissJob(sj.job.id);
      projects.delete(id);
      await kv.del("projects", id);
      emitLib({ type: "deleted", projectId: id });
    },
    deleteVersion: async (id) => {
      const v = requireVersion(id);
      const p = requireProject(v.projectId);
      const siblings = [...versions.values()].filter((x) => x.projectId === p.id && x.id !== id);
      if (siblings.length === 0) throw new BackendError("validation", "A project needs at least one version.", "Delete the whole project from the Library instead.");
      // Re-parent children so the tree stays connected.
      for (const child of siblings.filter((x) => x.parentId === id)) {
        const updated = { ...child, parentId: v.parentId };
        versions.set(child.id, updated);
        await kv.put("versions", child.id, updated);
      }
      versions.delete(id);
      await kv.del("versions", id);
      await kv.del("blobs", `model:${id}`);
      await kv.del("blobs", `thumb:${id}`);
      const latest = siblings.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
      await saveProject({
        ...p,
        versionCount: p.versionCount - 1,
        sizeBytes: Math.max(0, p.sizeBytes - v.fileSize),
        currentVersionId: p.currentVersionId === id ? latest.id : p.currentVersionId,
        thumbnailVersionId: p.thumbnailVersionId === id ? (latest.hasThumbnail ? latest.id : null) : p.thumbnailVersionId,
      });
      emitLib({ type: "project", projectId: p.id });
    },
    setCurrentVersion: async (projectId, versionId) => {
      requireVersion(versionId);
      const p = requireProject(projectId);
      const v = versions.get(versionId)!;
      await saveProject({ ...p, currentVersionId: versionId, thumbnailVersionId: v.hasThumbnail ? versionId : p.thumbnailVersionId });
      emitLib({ type: "project", projectId });
    },
    createVersion: async (meta, glb) => addVersion(meta, glb),
    saveThumbnail: async (versionId, image) => {
      const v = requireVersion(versionId);
      await kv.put("blobs", `thumb:${versionId}`, image);
      const old = thumbs.get(versionId);
      if (old) URL.revokeObjectURL(old);
      thumbs.set(versionId, URL.createObjectURL(new Blob([image as BlobPart], { type: "image/webp" })));
      const updated = { ...v, hasThumbnail: true };
      versions.set(versionId, updated);
      await kv.put("versions", versionId, updated);
      const p = projects.get(v.projectId);
      if (p && (p.currentVersionId === versionId || !p.thumbnailVersionId)) {
        await saveProject({ ...p, thumbnailVersionId: versionId });
      }
      emitLib({ type: "project", projectId: v.projectId });
    },
    onLibraryChanged: (cb) => {
      libListeners.add(cb);
      return () => libListeners.delete(cb);
    },
    readModel: async (versionId) => {
      const b = await modelBytes(versionId);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    thumbnailUrl: (versionId) => thumbs.get(versionId) ?? "",

    pickImages: async (multiple) => {
      const files = await pickFiles("image/png,image/jpeg,image/webp", multiple);
      const out: StagedImage[] = [];
      for (const f of files) out.push(await stage(f.name, new Uint8Array(await f.arrayBuffer())));
      return out;
    },
    stageImageBytes: async (name, bytes) => {
      if (!isImageBytes(bytes)) throw new BackendError("validation", "The clipboard doesn't contain a PNG, JPEG or WebP image.");
      return stage(name, bytes);
    },
    importModel: async (source) => {
      let file: File | undefined;
      if (source === "pick") file = (await pickFiles(".glb,.gltf", false))[0];
      else file = droppedFiles.get(source.token);
      if (!file) return null;
      if (file.size > MAX_MODEL_BYTES) throw new BackendError("validation", `${file.name} is larger than 256 MB.`);
      return importGlbBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    },
    openProjectFile: async (source) => {
      let file: File | undefined;
      if (source === "pick") file = (await pickFiles(".shift3d", false))[0];
      else file = droppedFiles.get(source.token);
      if (!file) return null;
      if (file.size > 512 * 1024 * 1024) throw new BackendError("validation", `${file.name} is larger than 512 MB.`);
      return importShift3d(new Uint8Array(await file.arrayBuffer()));
    },
    saveProjectFile: async (projectId) => {
      const detail = await api.getProject(projectId);
      const files: Record<string, Uint8Array> = {
        "project.json": strToU8(JSON.stringify({ format: "shift3d", formatVersion: 1, app: APP_VERSION, project: detail.project, versions: detail.versions }, null, 2)),
      };
      for (const v of detail.versions) {
        files[`versions/${v.id}.glb`] = await modelBytes(v.id);
        const thumb = await kv.get<Uint8Array>("blobs", `thumb:${v.id}`);
        if (thumb) files[`thumbs/${v.id}.webp`] = thumb;
      }
      const zip = zipSync(files, { level: 0 });
      const name = `${detail.project.name.replace(/[^\w\- ]+/g, "").trim() || "project"}.shift3d`;
      downloadBytes(name, zip, MIME.zip!);
      return { path: name, files: [name], bytes: zip.length };
    },
    exportFiles: async ({ suggestedName, format, files }) => {
      if (files.length === 1) {
        const f = files[0]!;
        downloadBytes(f.name, f.bytes, MIME[format] ?? "application/octet-stream");
        return { path: f.name, files: [f.name], bytes: f.bytes.length };
      }
      const zip = zipSync(Object.fromEntries(files.map((f: ExportFile) => [f.name, f.bytes])));
      const name = `${suggestedName}.zip`;
      downloadBytes(name, zip, MIME.zip!);
      return { path: name, files: files.map((f) => f.name), bytes: zip.length };
    },
    saveMedia: async ({ suggestedName, kind, bytes }: { suggestedName: string; kind: MediaKind; bytes: Uint8Array }) => {
      const name = `${suggestedName}.${kind}`;
      downloadBytes(name, bytes, MIME[kind]!);
      return { path: name, files: [name], bytes: bytes.length };
    },
    sendToGodot: async () => {
      throw unsupported("Send to Godot");
    },
    pickGodotProject: async () => {
      throw unsupported("Linking a Godot project");
    },
    pickBlenderPath: async () => {
      throw unsupported("Blender integration");
    },
    pickOutputDir: async () => {
      throw unsupported("Choosing an output folder");
    },
    detectBlender: async () => null,
    openInBlender: async () => {
      throw unsupported("Open in Blender");
    },
    reveal: async () => {
      throw unsupported("Show in Explorer");
    },
    onDrop: (cb) => {
      dropListeners.add(cb);
      return () => dropListeners.delete(cb);
    },
    onDragState: (cb): Unsubscribe => {
      dragListeners.add(cb);
      return () => dragListeners.delete(cb);
    },
  };
  return api;
}
