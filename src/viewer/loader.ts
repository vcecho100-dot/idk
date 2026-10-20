import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/errors";

let loader: GLTFLoader | null = null;

/** GLTFLoader with locally bundled Draco (wasm) and meshopt decoders — no CDN. */
export function gltfLoader(): GLTFLoader {
  if (loader) return loader;
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
  draco.setDecoderConfig({ type: "wasm" });
  loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export async function parseGlb(buffer: ArrayBuffer): Promise<GLTF> {
  try {
    return await gltfLoader().parseAsync(buffer, "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/KTX2/i.test(msg)) {
      throw new BackendError("unsupported", "This model uses KTX2 textures, which the viewer can't display yet.", "Re-export it with PNG/JPEG textures.");
    }
    throw new BackendError("validation", "This model couldn't be read.", "It may be corrupt. Try re-exporting it as GLB.");
  }
}

export interface LoadedModel {
  gltf: GLTF;
  bytes: number;
}

/** Small LRU of parsed models so switching versions and comparing is instant. */
const cache = new Map<string, Promise<LoadedModel>>();
/** How many live viewport instances use each model (clones share GPU buffers). */
const refs = new Map<string, number>();
/** Evicted while still in use — disposed when the last user releases it. */
const orphans = new Map<string, Promise<LoadedModel>>();
const MAX = 6;

export function loadVersion(versionId: string): Promise<LoadedModel> {
  const hit = cache.get(versionId);
  if (hit) {
    cache.delete(versionId);
    cache.set(versionId, hit);
    return hit;
  }
  const orphan = orphans.get(versionId);
  if (orphan) {
    orphans.delete(versionId);
    cache.set(versionId, orphan);
    return orphan;
  }
  const p = getBackend()
    .readModel(versionId)
    .then(async (buf) => ({ gltf: await parseGlb(buf), bytes: buf.byteLength }));
  p.catch(() => cache.delete(versionId));
  cache.set(versionId, p);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value as string;
    const evicted = cache.get(oldest)!;
    cache.delete(oldest);
    if ((refs.get(oldest) ?? 0) > 0) orphans.set(oldest, evicted);
    else void evicted.then((m) => disposeScene(m.gltf.scene)).catch(() => {});
  }
  return p;
}

export function acquire(versionId: string): void {
  refs.set(versionId, (refs.get(versionId) ?? 0) + 1);
}

export function release(versionId: string): void {
  const n = (refs.get(versionId) ?? 1) - 1;
  if (n > 0) {
    refs.set(versionId, n);
    return;
  }
  refs.delete(versionId);
  const orphan = orphans.get(versionId);
  if (orphan) {
    orphans.delete(versionId);
    void orphan.then((m) => disposeScene(m.gltf.scene)).catch(() => {});
  }
}

/** Each viewport instance needs its own scene graph (skinned meshes must be deep-cloned). */
export function instantiate(gltf: GLTF): THREE.Object3D {
  return skeletonClone(gltf.scene);
}

export function disposeScene(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

export function evictVersion(versionId: string): void {
  const p = cache.get(versionId);
  cache.delete(versionId);
  if (p && (refs.get(versionId) ?? 0) > 0) orphans.set(versionId, p);
  else void p?.then((m) => disposeScene(m.gltf.scene)).catch(() => {});
}
