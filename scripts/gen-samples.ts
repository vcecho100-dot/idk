/**
 * Generates Shift3D's procedural low-poly sample models (MIT) used by mock mode
 * for categories without a permissively licensed Khronos sample.
 *
 *   node scripts/gen-samples.ts
 *
 * Output: src-tauri/samples/{Sword,House,Robot,Tree,Crystal}.glb
 */
import { Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Mat {
  name: string;
  color: number;
  metal?: number;
  rough?: number;
  emissive?: number;
  emissiveStrength?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tr(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

class Builder {
  private parts = new Map<string, { mat: Mat; positions: number[]; normals: number[] }>();

  add(geometry: THREE.BufferGeometry, mat: Mat, matrix = new THREE.Matrix4()): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(matrix);
    g.deleteAttribute("normal");
    g.computeVertexNormals(); // non-indexed → flat facets
    const part = this.parts.get(mat.name) ?? { mat, positions: [], normals: [] };
    part.positions.push(...(g.getAttribute("position").array as Float32Array));
    part.normals.push(...(g.getAttribute("normal").array as Float32Array));
    this.parts.set(mat.name, part);
    return this;
  }

  /** Adds raw triangles (counter-clockwise, flat-shaded). */
  tris(points: [number, number, number][], mat: Mat, matrix = new THREE.Matrix4()): this {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
    return this.add(g, mat, matrix);
  }

  /** Moves the model so it sits on y = 0 and is centered on x/z. */
  private grounded(): void {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) {
      for (let i = 0; i < p.positions.length; i += 3) {
        box.expandByPoint(new THREE.Vector3(p.positions[i], p.positions[i + 1], p.positions[i + 2]));
      }
    }
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    for (const p of this.parts.values()) {
      for (let i = 0; i < p.positions.length; i += 3) {
        p.positions[i]! -= cx;
        p.positions[i + 1]! -= box.min.y;
        p.positions[i + 2]! -= cz;
      }
    }
  }

  async toGlb(name: string): Promise<Uint8Array> {
    this.grounded();
    const doc = new Document();
    doc.getRoot().getAsset().generator = "Shift3D procedural samples";
    const buffer = doc.createBuffer();
    const mesh = doc.createMesh(name);
    for (const { mat, positions, normals } of this.parts.values()) {
      const c = new THREE.Color(mat.color); // sRGB hex → linear working space
      const material = doc
        .createMaterial(mat.name)
        .setBaseColorFactor([c.r, c.g, c.b, 1])
        .setMetallicFactor(mat.metal ?? 0)
        .setRoughnessFactor(mat.rough ?? 0.7);
      if (mat.emissive !== undefined) {
        const e = new THREE.Color(mat.emissive);
        const s = mat.emissiveStrength ?? 1;
        material.setEmissiveFactor([Math.min(1, e.r * s), Math.min(1, e.g * s), Math.min(1, e.b * s)]);
      }
      const prim = doc
        .createPrimitive()
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
        .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
        .setMaterial(material);
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(name).setMesh(mesh);
    doc.createScene(name).addChild(node);
    return new NodeIO().writeBinary(doc);
  }
}

/* -------------------------------- Materials -------------------------------- */

const steel: Mat = { name: "Steel", color: 0xc9ced8, metal: 1, rough: 0.28 };
const gold: Mat = { name: "Gold", color: 0xe0a93b, metal: 1, rough: 0.32 };
const leather: Mat = { name: "Leather", color: 0x5a3626, rough: 0.85 };
const gem: Mat = { name: "Gem", color: 0x7c3aed, rough: 0.12, emissive: 0x6d28d9, emissiveStrength: 0.6 };

/* --------------------------------- Models --------------------------------- */

function sword(): Builder {
  const b = new Builder();
  // Diamond-section blade tapering to a tip.
  const y0 = 0.24, y1 = 1.02, tip = 1.16, w0 = 0.042, w1 = 0.034, t = 0.011;
  const ring = (y: number, w: number): [number, number, number][] => [[w, y, 0], [0, y, t], [-w, y, 0], [0, y, -t]];
  const r0 = ring(y0, w0), r1 = ring(y1, w1);
  const top: [number, number, number] = [0, tip, 0];
  const tris: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    tris.push(r0[i]!, r0[j]!, r1[j]!, r0[i]!, r1[j]!, r1[i]!, r1[i]!, r1[j]!, top);
  }
  b.tris(tris, steel);
  // Fuller (darker inset strip) suggested by a thin raised ridge.
  b.add(new THREE.BoxGeometry(0.006, 0.62, 0.024), { ...steel, name: "SteelDark", color: 0x8d93a0 }, tr(0, 0.6, 0));
  // Guard, grip, pommel.
  b.add(new THREE.BoxGeometry(0.3, 0.034, 0.06), gold, tr(0, 0.215, 0));
  b.add(new THREE.CylinderGeometry(0.03, 0.022, 0.05, 8), gold, tr(0.15, 0.215, 0, 0, 0, Math.PI / 2));
  b.add(new THREE.CylinderGeometry(0.022, 0.03, 0.05, 8), gold, tr(-0.15, 0.215, 0, 0, 0, Math.PI / 2));
  b.add(new THREE.CylinderGeometry(0.021, 0.023, 0.17, 8), leather, tr(0, 0.11, 0));
  for (let i = 0; i < 4; i++) b.add(new THREE.TorusGeometry(0.023, 0.004, 4, 10), leather, tr(0, 0.05 + i * 0.04, 0, Math.PI / 2));
  b.add(new THREE.IcosahedronGeometry(0.036, 0), gold, tr(0, 0.012, 0));
  b.add(new THREE.OctahedronGeometry(0.016, 0), gem, tr(0, 0.215, 0.034, 0, 0, Math.PI / 4));
  return b;
}

function house(): Builder {
  const b = new Builder();
  const stone: Mat = { name: "Stone", color: 0x8b8f98, rough: 0.95 };
  const plaster: Mat = { name: "Plaster", color: 0xf1e6d2, rough: 0.9 };
  const roof: Mat = { name: "RoofTiles", color: 0xb5523b, rough: 0.8 };
  const wood: Mat = { name: "Wood", color: 0x7a4b2a, rough: 0.85 };
  const glass: Mat = { name: "WindowGlow", color: 0xffd58a, rough: 0.3, emissive: 0xffb84d, emissiveStrength: 0.9 };
  const brick: Mat = { name: "Brick", color: 0x8e3b2e, rough: 0.9 };

  b.add(new THREE.BoxGeometry(2.3, 0.22, 1.9), stone, tr(0, 0.11, 0));
  b.add(new THREE.BoxGeometry(2.0, 1.3, 1.6), plaster, tr(0, 0.87, 0));
  // Timber frame corners and beams.
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.add(new THREE.BoxGeometry(0.1, 1.3, 0.1), wood, tr(x * 0.97, 0.87, z * 0.77));
  b.add(new THREE.BoxGeometry(2.08, 0.08, 1.68), wood, tr(0, 1.52, 0));
  // Gable roof (triangular prism) with overhang.
  const w = 1.22, d = 1.02, h0 = 1.56, h1 = 2.42;
  const L: [number, number, number][] = [
    [-w, h0, d], [w, h0, d], [0, h1, d],
    [w, h0, -d], [-w, h0, -d], [0, h1, -d],
    [-w, h0, -d], [-w, h0, d], [0, h1, d], [-w, h0, -d], [0, h1, d], [0, h1, -d],
    [w, h0, d], [w, h0, -d], [0, h1, -d], [w, h0, d], [0, h1, -d], [0, h1, d],
    [-w, h0, d], [-w, h0, -d], [w, h0, -d], [-w, h0, d], [w, h0, -d], [w, h0, d],
  ];
  b.tris(L.slice(6, 18), roof);
  b.tris(L.slice(0, 6), plaster);
  b.tris(L.slice(18), wood);
  b.add(new THREE.BoxGeometry(0.1, 0.1, 2.1), wood, tr(0, h1 + 0.02, 0));
  // Door, windows, chimney, step.
  b.add(new THREE.BoxGeometry(0.46, 0.82, 0.06), wood, tr(0, 0.63, 0.81));
  b.add(new THREE.SphereGeometry(0.025, 6, 4), { name: "Brass", color: 0xd4a24c, metal: 1, rough: 0.35 }, tr(0.15, 0.62, 0.85));
  for (const x of [-0.62, 0.62]) {
    b.add(new THREE.BoxGeometry(0.42, 0.42, 0.05), glass, tr(x, 0.98, 0.805));
    b.add(new THREE.BoxGeometry(0.5, 0.06, 0.1), wood, tr(x, 0.75, 0.83));
    b.add(new THREE.BoxGeometry(0.04, 0.42, 0.07), wood, tr(x, 0.98, 0.83));
  }
  b.add(new THREE.BoxGeometry(0.42, 0.42, 0.05), glass, tr(-0.55, 1.95, 1.0));
  b.add(new THREE.BoxGeometry(0.28, 0.8, 0.28), brick, tr(0.62, 2.25, -0.35));
  b.add(new THREE.BoxGeometry(0.34, 0.08, 0.34), stone, tr(0.62, 2.66, -0.35));
  b.add(new THREE.BoxGeometry(0.7, 0.1, 0.32), stone, tr(0, 0.05, 1.08));
  return b;
}

function robot(): Builder {
  const b = new Builder();
  const shell: Mat = { name: "Shell", color: 0xe9e9ef, metal: 0.15, rough: 0.32 };
  const joint: Mat = { name: "Joints", color: 0x2b2b35, metal: 0.7, rough: 0.4 };
  const accent: Mat = { name: "Accent", color: 0xff7a1a, metal: 0.2, rough: 0.4 };
  const visor: Mat = { name: "Visor", color: 0x0b1220, rough: 0.1, metal: 0.3 };
  const glow: Mat = { name: "Glow", color: 0x22d3ee, rough: 0.2, emissive: 0x22d3ee, emissiveStrength: 1.2 };

  // Legs
  for (const x of [-0.17, 0.17]) {
    b.add(new THREE.BoxGeometry(0.2, 0.08, 0.3), joint, tr(x, 0.04, 0.03));
    b.add(new THREE.BoxGeometry(0.16, 0.36, 0.17), shell, tr(x, 0.28, 0));
    b.add(new THREE.SphereGeometry(0.075, 8, 6), joint, tr(x, 0.48, 0));
    b.add(new THREE.BoxGeometry(0.17, 0.3, 0.18), shell, tr(x, 0.64, 0));
    b.add(new THREE.BoxGeometry(0.18, 0.05, 0.19), accent, tr(x, 0.33, 0));
  }
  // Pelvis & torso
  b.add(new THREE.BoxGeometry(0.48, 0.14, 0.26), joint, tr(0, 0.82, 0));
  b.add(new THREE.BoxGeometry(0.56, 0.5, 0.34), shell, tr(0, 1.13, 0));
  b.add(new THREE.BoxGeometry(0.3, 0.16, 0.04), visor, tr(0, 1.2, 0.18));
  b.add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), glow, tr(0, 1.2, 0.2, Math.PI / 2));
  b.add(new THREE.BoxGeometry(0.58, 0.06, 0.36), accent, tr(0, 0.94, 0));
  // Arms
  for (const s of [-1, 1]) {
    b.add(new THREE.SphereGeometry(0.09, 8, 6), joint, tr(s * 0.34, 1.3, 0));
    b.add(new THREE.CylinderGeometry(0.06, 0.055, 0.32, 8), shell, tr(s * 0.36, 1.1, 0, 0, 0, s * 0.08));
    b.add(new THREE.SphereGeometry(0.055, 8, 6), joint, tr(s * 0.38, 0.92, 0));
    b.add(new THREE.CylinderGeometry(0.055, 0.05, 0.28, 8), shell, tr(s * 0.39, 0.76, 0.02, 0.1));
    b.add(new THREE.BoxGeometry(0.11, 0.12, 0.1), joint, tr(s * 0.39, 0.58, 0.04));
  }
  // Head
  b.add(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 8), joint, tr(0, 1.42, 0));
  b.add(new THREE.BoxGeometry(0.36, 0.28, 0.3), shell, tr(0, 1.59, 0));
  b.add(new THREE.BoxGeometry(0.3, 0.1, 0.04), visor, tr(0, 1.6, 0.15));
  b.add(new THREE.BoxGeometry(0.24, 0.03, 0.02), glow, tr(0, 1.6, 0.172));
  b.add(new THREE.CylinderGeometry(0.008, 0.01, 0.14, 6), joint, tr(0.1, 1.79, 0));
  b.add(new THREE.SphereGeometry(0.022, 8, 6), accent, tr(0.1, 1.87, 0));
  for (const s of [-1, 1]) b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10), accent, tr(s * 0.2, 1.59, 0, 0, 0, Math.PI / 2));
  return b;
}

function tree(): Builder {
  const b = new Builder();
  const rand = mulberry32(7);
  const bark: Mat = { name: "Bark", color: 0x6b4428, rough: 0.95 };
  const leaves = [
    { name: "LeavesDark", color: 0x2f7d3b, rough: 0.8 },
    { name: "Leaves", color: 0x47a347, rough: 0.8 },
    { name: "LeavesLight", color: 0x7cc46b, rough: 0.8 },
  ] satisfies Mat[];
  const rockMat: Mat = { name: "Rock", color: 0x8a8f99, rough: 0.95 };

  b.add(new THREE.CylinderGeometry(0.11, 0.2, 1.2, 7), bark, tr(0, 0.6, 0));
  b.add(new THREE.CylinderGeometry(0.05, 0.08, 0.6, 6), bark, tr(0.22, 1.05, 0, 0, 0, -0.7));
  b.add(new THREE.CylinderGeometry(0.04, 0.07, 0.5, 6), bark, tr(-0.18, 1.15, 0.05, 0.2, 0, 0.8));

  const blob = (r: number, x: number, y: number, z: number, mat: Mat) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const pos = g.getAttribute("position");
    const seen = new Map<string, number>();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      const k = seen.get(key) ?? 0.86 + rand() * 0.28;
      seen.set(key, k);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.9, pos.getZ(i) * k);
    }
    b.add(g, mat, tr(x, y, z));
  };
  blob(0.78, 0, 1.75, 0, leaves[1]);
  blob(0.55, 0.52, 1.45, 0.15, leaves[0]);
  blob(0.5, -0.5, 1.5, -0.1, leaves[0]);
  blob(0.48, 0.05, 2.35, 0.05, leaves[2]);
  blob(0.36, -0.25, 1.9, 0.55, leaves[2]);
  blob(0.18, 0.55, 0.09, 0.35, rockMat);
  blob(0.12, 0.72, 0.06, 0.12, rockMat);
  return b;
}

function crystal(): Builder {
  const b = new Builder();
  const rand = mulberry32(42);
  const rock: Mat = { name: "Rock", color: 0x5b5d66, rough: 0.95 };
  const crystals = [
    { name: "Amethyst", color: 0x8b5cf6, rough: 0.12, metal: 0, emissive: 0x7c3aed, emissiveStrength: 0.5 },
    { name: "AmethystPale", color: 0xc4b5fd, rough: 0.1, metal: 0, emissive: 0x8b5cf6, emissiveStrength: 0.35 },
    { name: "Aqua", color: 0x22d3ee, rough: 0.1, metal: 0, emissive: 0x0891b2, emissiveStrength: 0.5 },
  ] satisfies Mat[];

  const base = new THREE.IcosahedronGeometry(0.55, 1);
  const p = base.getAttribute("position");
  for (let i = 0; i < p.count; i++) p.setY(i, Math.max(p.getY(i) * 0.45, -0.05));
  b.add(base, rock, tr(0, 0.12, 0));

  const shard = (h: number, r: number, x: number, z: number, tiltX: number, tiltZ: number, mat: Mat) => {
    const m = tr(x, 0.18, z, tiltX, rand() * Math.PI, tiltZ);
    b.add(new THREE.CylinderGeometry(r, r * 1.05, h, 6), mat, m.clone().multiply(tr(0, h / 2, 0)));
    b.add(new THREE.ConeGeometry(r, r * 2.2, 6), mat, m.clone().multiply(tr(0, h + r * 1.1, 0)));
  };
  shard(0.95, 0.13, 0, 0, 0.05, -0.08, crystals[0]);
  shard(0.62, 0.1, 0.22, 0.12, 0.25, -0.45, crystals[1]);
  shard(0.7, 0.1, -0.22, 0.05, -0.15, 0.5, crystals[0]);
  shard(0.45, 0.08, 0.05, -0.25, -0.55, 0.1, crystals[2]);
  shard(0.38, 0.07, -0.12, 0.28, 0.6, 0.25, crystals[1]);
  shard(0.3, 0.06, 0.32, -0.12, -0.3, -0.7, crystals[2]);
  return b;
}

/* ---------------------------------- Main ---------------------------------- */

const outDir = fileURLToPath(new URL("../src-tauri/samples/", import.meta.url));
const models: [string, () => Builder][] = [
  ["Sword", sword],
  ["House", house],
  ["Robot", robot],
  ["Tree", tree],
  ["Crystal", crystal],
];
for (const [name, make] of models) {
  const glb = await make().toGlb(name);
  writeFileSync(`${outDir}${name}.glb`, glb);
  console.warn(`${name}.glb  ${(glb.length / 1024).toFixed(1)} KB`);
}
