import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGlb, type GltfJson } from "@/lib/gltf/glb";

// Vitest runs from the project root (jsdom makes import.meta.url an http URL).
const SAMPLES = join(process.cwd(), "src-tauri", "samples");

/** Reads a bundled sample (the same files the Rust engine embeds). */
export function sampleBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SAMPLES, file)));
}

/** A minimal one-triangle GLB with a single material. */
export function triangleGlb(): Uint8Array {
  const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json: GltfJson = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }] as never,
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] }, normalTexture: { index: 0 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }] as never,
  };
  return buildGlb({ json, bin });
}
