/**
 * Minimal, dependency-free GLB container helpers. Used for validation, stats and
 * lightweight material edits without decoding meshes or textures.
 */
import type { ModelStats } from "@/lib/backend/types";

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export interface GltfJson {
  asset?: { version?: string; generator?: string };
  accessors?: { count: number; componentType: number; type: string; bufferView?: number; byteOffset?: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number }[] }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; sampler?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string; name?: string }[];
  animations?: { name?: string }[];
  skins?: unknown[];
  nodes?: unknown[];
  extensionsUsed?: string[];
  [key: string]: unknown;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: { index: number };
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number; scale?: number };
  occlusionTexture?: { index: number };
  emissiveTexture?: { index: number };
  emissiveFactor?: [number, number, number];
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Glb {
  json: GltfJson;
  bin: Uint8Array | null;
}

export class GlbError extends Error {}

export function isGlb(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === MAGIC;
}

export function parseGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== MAGIC) throw new GlbError("Not a GLB file (bad magic header).");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbError(`Unsupported glTF container version ${version}.`);
  const length = view.getUint32(8, true);
  if (length > bytes.length) throw new GlbError("GLB file is truncated.");

  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > length) throw new GlbError("GLB chunk exceeds file length.");
    const data = bytes.subarray(offset, offset + chunkLength);
    if (chunkType === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data)) as GltfJson;
    else if (chunkType === CHUNK_BIN && !bin) bin = data;
    offset += chunkLength;
  }
  if (!json) throw new GlbError("GLB has no JSON chunk.");
  return { json, bin };
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export function buildGlb({ json, bin }: Glb): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const binLen = bin ? pad4(bin.length) : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // JSON is space-padded
  if (bin) {
    const o = 20 + jsonLen;
    view.setUint32(o, binLen, true);
    view.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8);
  }
  return out;
}

/* ---------------------------------- Images ---------------------------------- */

/** Reads width/height from PNG, JPEG or WebP headers. Returns null for unknown formats. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // PNG: 89 50 4E 47 ... IHDR width/height at 16/20 (big-endian)
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  // JPEG: scan for SOFn marker
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let o = 2;
    while (o + 9 < data.length) {
      if (data[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = data[o + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: v.getUint16(o + 5), width: v.getUint16(o + 7) };
      }
      const len = v.getUint16(o + 2);
      o += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP
  if (data.length >= 30 && data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57 && data[9] === 0x45) {
    const format = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
    if (format === "VP8X") return { width: 1 + (v.getUint32(24, true) & 0xffffff), height: 1 + (v.getUint32(27, true) & 0xffffff) };
    if (format === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (format === "VP8L") {
      const b = v.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/* ---------------------------------- Stats ---------------------------------- */

export function computeStats(bytes: Uint8Array): ModelStats {
  const { json, bin } = parseGlb(bytes);
  let triangles = 0;
  const vertexAccessors = new Set<number>();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const mode = prim.mode ?? 4;
      const pos = prim.attributes.POSITION;
      if (pos !== undefined) vertexAccessors.add(pos);
      const count = prim.indices !== undefined ? json.accessors?.[prim.indices]?.count ?? 0 : pos !== undefined ? json.accessors?.[pos]?.count ?? 0 : 0;
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
    }
  }
  let vertices = 0;
  for (const a of vertexAccessors) vertices += json.accessors?.[a]?.count ?? 0;

  let maxTextureSize = 0;
  for (const img of json.images ?? []) {
    if (img.bufferView === undefined || !bin) continue;
    const bv = json.bufferViews?.[img.bufferView];
    if (!bv) continue;
    const start = bv.byteOffset ?? 0;
    const size = imageSize(bin.subarray(start, start + Math.min(bv.byteLength, 64 * 1024)));
    if (size) maxTextureSize = Math.max(maxTextureSize, size.width, size.height);
  }

  return {
    triangles,
    vertices,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    maxTextureSize,
    fileSize: bytes.length,
    animations: (json.animations ?? []).map((a, i) => a.name || `Animation ${i + 1}`),
    hasSkin: (json.skins?.length ?? 0) > 0,
  };
}

/* ----------------------------- Material editing ----------------------------- */

export function editMaterials(bytes: Uint8Array, edit: (m: GltfMaterial, index: number) => void): Uint8Array {
  const glb = parseGlb(bytes);
  glb.json.materials ??= [];
  glb.json.materials.forEach(edit);
  return buildGlb(glb);
}

/** Multiplies base colors by an RGB tint (keeps textures, so it reads as a recolor). */
export function tintGlb(bytes: Uint8Array, tint: [number, number, number], strength = 1): Uint8Array {
  return editMaterials(bytes, (m) => {
    m.pbrMetallicRoughness ??= {};
    const [r, g, b, a] = m.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1];
    const mix = (c: number, t: number) => c * (1 - strength + strength * t);
    m.pbrMetallicRoughness.baseColorFactor = [mix(r, tint[0]), mix(g, tint[1]), mix(b, tint[2]), a];
  });
}

export interface MaterialEditInput {
  tint: [number, number, number] | null;
  metallic: number | null;
  roughness: number | null;
  emissive: [number, number, number] | null;
}

/** Applies a retexture edit to every material (used by mock retexture). */
export function applyMaterialEdit(bytes: Uint8Array, edit: MaterialEditInput): Uint8Array {
  return editMaterials(bytes, (m) => {
    const pbr = (m.pbrMetallicRoughness ??= {});
    if (edit.tint) {
      const [r, g, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
      const t = edit.tint;
      // Blend toward the tint (rather than pure multiply) so dark textures still change visibly.
      pbr.baseColorFactor = [
        Math.min(1, r * 0.25 + t[0] * 0.75 * r + 0.08 * t[0]),
        Math.min(1, g * 0.25 + t[1] * 0.75 * g + 0.08 * t[1]),
        Math.min(1, b * 0.25 + t[2] * 0.75 * b + 0.08 * t[2]),
        a,
      ];
    }
    if (edit.metallic !== null) {
      pbr.metallicFactor = edit.metallic;
      delete pbr.metallicRoughnessTexture;
    }
    if (edit.roughness !== null) pbr.roughnessFactor = edit.roughness;
    if (edit.emissive) {
      m.emissiveFactor = edit.emissive;
      if (pbr.baseColorTexture && !m.emissiveTexture) m.emissiveTexture = { index: pbr.baseColorTexture.index };
    }
  });
}

/** A "draft" look: drops detail maps (normal, occlusion, metal/rough) so refining visibly adds them back. */
export function draftGlb(bytes: Uint8Array): Uint8Array {
  return editMaterials(bytes, (m) => {
    delete m.normalTexture;
    delete m.occlusionTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
      m.pbrMetallicRoughness.roughnessFactor = Math.max(m.pbrMetallicRoughness.roughnessFactor ?? 1, 0.85);
    }
  });
}
