import { useEffect, useState } from "react";
import * as THREE from "three";
import type { AnimationClip } from "three";
import { errorMessage } from "@/lib/backend";
import { acquire, instantiate, loadVersion, release } from "./loader";

export interface ViewModel {
  versionId: string;
  root: THREE.Object3D;
  clips: AnimationClip[];
  bytes: number;
  /** Bounding info in the model's own space. */
  box: THREE.Box3;
  size: THREE.Vector3;
  radius: number;
}

export function frame(root: THREE.Object3D, clips: AnimationClip[] = []): Pick<ViewModel, "box" | "size" | "radius"> {
  // Animated models are shown playing, and a rest pose can differ wildly from the first frame
  // (some rigs lie flat until animated), so pose the first frame and measure that. The pose is
  // left applied (stopping the mixer would restore the rest pose), which also suits thumbnails.
  const first = clips[0];
  const mixer = first ? new THREE.AnimationMixer(root) : null;
  if (mixer && first) {
    mixer.clipAction(first).play();
    mixer.update(0);
  }
  // updateMatrixWorld (not updateWorldMatrix) so skinned meshes also refresh their bind matrices.
  root.updateMatrixWorld(true);
  // Skinned vertices are measured through their bones, which aren't posed until the first render.
  root.traverse((o) => {
    const s = o as THREE.SkinnedMesh;
    if (!s.isSkinnedMesh) return;
    s.skeleton.update();
    s.computeBoundingBox();
    s.computeBoundingSphere();
  });
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-3);
  return { box, size, radius };
}

/** Each instance gets its own materials so live edits never touch the shared cache. */
function ownMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
    m.frustumCulled = true;
  });
}

/**
 * Loads a version for display. The previous model stays on screen until the
 * next one is ready, so switching versions never flashes an empty viewport.
 */
export function useModel(versionId: string | null) {
  // State is tagged with the version it belongs to, so a stale result is never shown as current.
  const [state, setState] = useState<{
    key: string | null;
    model: ViewModel | null;
    error: { title: string; description?: string } | null;
  }>({ key: null, model: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const key = versionId ? `${versionId}#${attempt}` : null;

  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    const k = `${versionId}#${attempt}`;
    acquire(versionId);
    loadVersion(versionId)
      .then(({ gltf, bytes }) => {
        if (cancelled) return;
        const root = instantiate(gltf);
        ownMaterials(root);
        setState({ key: k, model: { versionId, root, clips: gltf.animations, bytes, ...frame(root, gltf.animations) }, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState((s) => ({ key: k, model: s.model, error: errorMessage(err) }));
      });
    return () => {
      cancelled = true;
      release(versionId);
    };
  }, [versionId, attempt]);

  if (!versionId) return { model: null, loading: false, error: null, retry: () => {} };
  const settled = state.key === key;
  return {
    model: state.model,
    loading: !settled,
    error: settled ? state.error : null,
    retry: () => setAttempt((a) => a + 1),
  };
}
