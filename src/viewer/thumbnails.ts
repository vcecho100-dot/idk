import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getBackend } from "@/lib/backend";
import type { Version } from "@/lib/backend/types";
import { acquire, instantiate, loadVersion, release } from "./loader";
import { cssColor } from "./tokens";
import { frame } from "./useModel";

/**
 * Renders library thumbnails for versions that have never been shown in the
 * viewport (variants, jobs that finished in the background). One small
 * offscreen renderer, one model at a time, procedural studio lighting.
 */
let renderer: THREE.WebGLRenderer | null = null;
let envMap: THREE.Texture | null = null;
const queue: Version[] = [];
const queued = new Set<string>();
let running = false;

const W = 480;
const H = 360;

function setup(): THREE.WebGLRenderer {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "low-power" });
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return renderer;
}

async function render(v: Version): Promise<void> {
  const r = setup();
  acquire(v.id);
  try {
    const { gltf } = await loadVersion(v.id);
    const root = instantiate(gltf);
    const scene = new THREE.Scene();
    scene.environment = envMap;
    scene.background = cssColor("--viewport-bottom").lerp(cssColor("--viewport-top"), 0.5);
    scene.add(root);
    const { box, radius } = frame(root, gltf.animations);
    const center = box.getCenter(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(35, W / H, radius / 100, radius * 100);
    cam.position.copy(center).add(new THREE.Vector3(0.62, 0.38, 0.69).normalize().multiplyScalar(radius / Math.sin(THREE.MathUtils.degToRad(17.5))));
    cam.lookAt(center);
    r.render(scene, cam);
    const blob = await new Promise<Blob | null>((res) => r.domElement.toBlob(res, "image/webp", 0.86));
    if (blob) await getBackend().saveThumbnail(v.id, new Uint8Array(await blob.arrayBuffer()));
  } finally {
    release(v.id);
  }
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const v = queue.shift()!;
      try {
        await render(v);
      } catch {
        /* a broken model just keeps its placeholder */
      }
      // Yield to the UI between thumbnails.
      await new Promise((res) => setTimeout(res, 50));
    }
  } finally {
    running = false;
  }
}

export function ensureThumbnails(versions: Version[]): void {
  for (const v of versions) {
    if (v.hasThumbnail || queued.has(v.id)) continue;
    queued.add(v.id);
    queue.push(v);
  }
  void pump();
}
