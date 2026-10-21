/**
 * Free generation on public Hugging Face Spaces, straight from the browser
 * (both Spaces allow cross-origin requests):
 * - text → image: `black-forest-labs/FLUX.1-schnell` (`/infer`)
 * - image → shape: `tencent/Hunyuan3D-2` (`/shape_generation`); the ~1–2.5M-triangle
 *   result is simplified here with meshoptimizer and the image is projected on as its
 *   texture. (`/generation_all` paints real textures but needs more GPU time than
 *   anonymous visitors get, so it fails for them.)
 * Mirrors the desktop engine's `providers/hfspace.rs`.
 */
import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { BackendError } from "../errors";
import type { Quality } from "../types";

export const FLUX_SPACE = "https://black-forest-labs-flux-1-schnell.hf.space";
export const HUNYUAN_SPACE = "https://tencent-hunyuan3d-2.hf.space";

type FileData = { path: string; url?: string; meta?: unknown };

interface Space {
  base: string;
  prefix: string;
  name: string;
}

/** The job's signal, plus a deadline so a stuck Space can't hang the job forever. */
function within(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function netError(name: string, err: unknown): BackendError {
  if (err instanceof BackendError) return err;
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new BackendError("timeout", `${name} isn't responding.`, "Free public Spaces sometimes go down or restart. Try again in a few minutes, or use the offline demo.");
  }
  if (err instanceof DOMException && err.name === "AbortError") return new BackendError("cancelled", "Canceled.");
  return new BackendError("network", `Couldn't reach ${name}.`, "Check your internet connection and try again.");
}

async function connect(base: string, name: string, signal: AbortSignal): Promise<Space> {
  try {
    const res = await fetch(`${base}/config`, { signal: within(signal, 30_000) });
    if (!res.ok) throw new BackendError("provider", `${name} isn't responding.`, "The Space may be asleep or restarting. Try again in a minute.");
    const config = (await res.json()) as { api_prefix?: string };
    return { base, prefix: config.api_prefix ?? "", name };
  } catch (err) {
    throw netError(name, err);
  }
}

async function upload(s: Space, bytes: Uint8Array, filename: string, mime: string, signal: AbortSignal): Promise<FileData> {
  const form = new FormData();
  form.append("files", new Blob([bytes as BlobPart], { type: mime }), filename);
  try {
    const res = await fetch(`${s.base}${s.prefix}/upload`, { method: "POST", body: form, signal: within(signal, 120_000) });
    const paths = (await res.json()) as string[];
    if (!res.ok || typeof paths?.[0] !== "string") throw new BackendError("provider", `${s.name} didn't accept the image.`);
    return { path: paths[0], meta: { _type: "gradio.FileData" } };
  } catch (err) {
    throw netError(s.name, err);
  }
}

function spaceError(s: Space, raw: string): BackendError {
  let msg = raw;
  try {
    const v = JSON.parse(raw) as unknown;
    msg = typeof v === "string" ? v : "";
  } catch {
    /* plain text */
  }
  const lower = msg.toLowerCase();
  if (!msg || lower.includes("quota") || lower.includes("gpu") || lower.includes("exceeded")) {
    // ZeroGPU Spaces report an exhausted quota as an error with no message.
    return new BackendError(
      "rate_limited",
      `${s.name} is busy or out of free GPU time.`,
      "Hugging Face gives each visitor a few minutes of free GPU a day. Try again later, use the offline demo, or get the desktop app and add a free Hugging Face token for more.",
    );
  }
  return new BackendError("provider", `${s.name}: ${msg.slice(0, 240)}`, "Try again, or use a different image.");
}

/** Runs one endpoint and returns its outputs. */
async function run(s: Space, api: string, data: unknown[], signal: AbortSignal): Promise<unknown[]> {
  try {
    const start = await fetch(`${s.base}${s.prefix}/call${api}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }), signal: within(signal, 60_000) });
    const { event_id } = (await start.json()) as { event_id?: string };
    if (!start.ok || !event_id) throw new BackendError("provider", `${s.name} didn't start the job.`, "Try again in a minute.");
    // Includes time waiting in the Space's queue.
    const res = await fetch(`${s.base}${s.prefix}/call${api}/${event_id}`, { signal: within(signal, 600_000) });
    if (!res.ok || !res.body) throw new BackendError("provider", `${s.name} didn't return a result.`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let event = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new BackendError("provider", `${s.name} closed the connection before finishing.`, "Try again in a moment.");
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const d = line.slice(5).trim();
          if (event === "complete") {
            void reader.cancel();
            const out = JSON.parse(d) as unknown;
            return Array.isArray(out) ? out : [];
          }
          if (event === "error") {
            void reader.cancel();
            throw spaceError(s, d);
          }
        }
      }
    }
  } catch (err) {
    throw netError(s.name, err);
  }
}

/** Outputs are either a FileData or a component update `{ value: FileData }`. */
function fileOf(v: unknown): FileData | null {
  const o = v as { value?: unknown; path?: unknown } | null;
  if (o && typeof o === "object" && o.value && typeof o.value === "object") return fileOf(o.value);
  return o && typeof o.path === "string" ? (o as FileData) : null;
}

async function download(s: Space, file: FileData, signal: AbortSignal): Promise<Uint8Array> {
  // Build the URL from the server path: the `url` some Spaces return is malformed.
  try {
    const res = await fetch(`${s.base}${s.prefix}/file=${file.path}`, { signal: within(signal, 300_000) });
    if (!res.ok) throw new BackendError("provider", `${s.name} lost the result file.`, "Try again.");
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw netError(s.name, err);
  }
}

/* -------------------------------- Projection -------------------------------- */

async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    throw new BackendError("validation", "The reference image couldn't be read.");
  }
}

/** Normalized (u0, v0, u1, v1) rectangle of the object in the image (the Space crops to it). */
function objectRect(px: ImageData): [number, number, number, number] {
  const { width: w, height: h, data } = px;
  if (w < 8 || h < 8) return [0, 0, 1, 1];
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) { hasAlpha = true; break; }
  const bg = [0, 0, 0];
  let n = 0;
  for (const [cx, cy] of [[0, 0], [w - 6, 0], [0, h - 6], [w - 6, h - 6]] as const) {
    for (let y = cy; y < cy + 6; y++)
      for (let x = cx; x < cx + 6; x++) {
        const i = (y * w + x) * 4;
        bg[0]! += data[i]!;
        bg[1]! += data[i + 1]!;
        bg[2]! += data[i + 2]!;
        n++;
      }
  }
  for (let k = 0; k < 3; k++) bg[k]! /= n;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const fg = hasAlpha ? data[i + 3]! > 127 : Math.abs(data[i]! - bg[0]!) + Math.abs(data[i + 1]! - bg[1]!) + Math.abs(data[i + 2]! - bg[2]!) > 48;
      if (fg) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  if (x1 <= x0 || y1 <= y0 || ((x1 - x0) * (y1 - y0)) / (w * h) > 0.98) return [0, 0, 1, 1];
  return [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
}

/**
 * Simplifies the mesh to about `maxTriangles`, then front-projects the image onto it as
 * its base color texture (PNG, so every engine reads it).
 */
export async function finishMesh(glb: Uint8Array, image: Uint8Array, mime: string, maxTriangles: number): Promise<Uint8Array> {
  const bitmap = await decodeImage(image, mime);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const [u0, v0, u1, v1] = objectRect(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!png) throw new BackendError("internal", "Couldn't encode the texture.");

  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(glb);
  const root = doc.getRoot();
  const triangles = root
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION")?.getCount() ?? 0) / 3, 0);
  if (triangles > maxTriangles * 1.2) {
    await MeshoptSimplifier.ready;
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: maxTriangles / triangles, error: 0.01 }));
  }
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  const el: number[] = [0, 0, 0];
  for (const p of prims) {
    const pos = p.getAttribute("POSITION");
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      for (let k = 0; k < 2; k++) {
        min[k] = Math.min(min[k]!, el[k]!);
        max[k] = Math.max(max[k]!, el[k]!);
      }
    }
  }
  const w = Math.max(max[0]! - min[0]!, 1e-6);
  const h = Math.max(max[1]! - min[1]!, 1e-6);
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const texture = doc.createTexture("projected").setImage(new Uint8Array(await png.arrayBuffer())).setMimeType("image/png");
  const material = doc.createMaterial("Projected").setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(0.75);
  for (const p of prims) {
    const pos = p.getAttribute("POSITION");
    if (!pos) continue;
    const uv = new Float32Array(pos.getCount() * 2);
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      uv[i * 2] = u0 + ((el[0]! - min[0]!) / w) * (u1 - u0);
      uv[i * 2 + 1] = v0 + (1 - (el[1]! - min[1]!) / h) * (v1 - v0);
    }
    p.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(uv).setBuffer(buffer));
    p.setMaterial(material);
  }
  return io.writeBinary(doc);
}

/* --------------------------------- Pipeline --------------------------------- */

export interface HfInput {
  prompt: string;
  image: { bytes: Uint8Array; mime: string; name: string } | null;
  quality: Quality;
  seed: number;
}

export interface HfResult {
  glb: Uint8Array;
  /** The FLUX reference image, when the input was text. */
  reference: Uint8Array | null;
}

/** Steps, octree resolution and target triangle count per quality. */
const PLAN: Record<Quality, { steps: number; octree: number; faces: number }> = {
  draft: { steps: 10, octree: 256, faces: 20_000 },
  standard: { steps: 20, octree: 256, faces: 40_000 },
  high: { steps: 30, octree: 384, faces: 80_000 },
};

export async function hfGenerate(input: HfInput, progress: (p: number, stage: string) => void, signal: AbortSignal): Promise<HfResult> {
  const plan = PLAN[input.quality];
  let image = input.image;
  let reference: Uint8Array | null = null;

  if (!image) {
    progress(0.04, "Painting a reference image with FLUX");
    const flux = await connect(FLUX_SPACE, "The free FLUX Space", signal);
    const prompt = `${input.prompt}, single object, centered, full view, plain white background, studio lighting`;
    const out = await run(flux, "/infer", [prompt, input.seed % 2_147_483_647, false, 1024, 1024, 4], signal);
    const file = fileOf(out[0]);
    if (!file) throw new BackendError("provider", "FLUX returned no image.", "Try again.");
    reference = await download(flux, file, signal);
    image = { bytes: reference, mime: "image/webp", name: "reference.webp" };
  }

  progress(0.22, "Building the 3D shape with Hunyuan3D-2");
  const hy = await connect(HUNYUAN_SPACE, "The free Hunyuan3D Space", signal);
  const ext = image.mime.split("/")[1] ?? "png";
  const uploaded = await upload(hy, image.bytes, `input.${ext}`, image.mime, signal);
  // caption, image, mv_front, mv_back, mv_left, mv_right, steps, guidance, seed, octree, remove_bg, num_chunks, randomize_seed
  const shapeOut = await run(hy, "/shape_generation", ["", uploaded, null, null, null, null, plan.steps, 5, input.seed % 10_000_000, plan.octree, true, 8000, false], signal);
  const shape = fileOf(shapeOut[0]);
  if (!shape) throw new BackendError("provider", "The free Hunyuan3D Space returned no model.", "Try again, or use a different image.");

  progress(0.55, "Downloading the mesh");
  const mesh = await download(hy, shape, signal);

  progress(0.85, "Simplifying the mesh and painting the texture");
  const glb = await finishMesh(mesh, image.bytes, image.mime, plan.faces);
  return { glb, reference };
}

export async function hfPing(signal: AbortSignal): Promise<number> {
  const t = performance.now();
  await Promise.all([connect(FLUX_SPACE, "The free FLUX Space", signal), connect(HUNYUAN_SPACE, "The free Hunyuan3D Space", signal)]);
  return Math.round(performance.now() - t);
}
