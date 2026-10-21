import * as THREE from "three";
import type { ViewerTokens } from "./tokens";

/* ---------------------------------------------------------------------------
 * "The Shift", part 2 — the model sweeps from wireframe → clay → textured.
 * Materials are cloned and patched for ~1s, then the originals come back.
 * ------------------------------------------------------------------------- */

export interface RevealHandle {
  /** 0..1 */
  update(t: number): void;
  dispose(): void;
}

const REVEAL_UNIFORMS = /* glsl */ `
  uniform float uS3dA;
  uniform float uS3dB;
  uniform float uS3dMinY;
  uniform float uS3dMaxY;
  uniform vec3 uS3dClay;
  uniform vec3 uS3dGlowA;
  uniform vec3 uS3dGlowB;
  varying float vS3dY;
`;

function patchSolid(m: THREE.Material, uniforms: Record<string, THREE.IUniform>): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying float vS3dY;`)
      .replace("#include <project_vertex>", `#include <project_vertex>\nvS3dY = (modelMatrix * vec4(transformed, 1.0)).y;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${REVEAL_UNIFORMS}`).replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
       float h = clamp((vS3dY - uS3dMinY) / max(uS3dMaxY - uS3dMinY, 1e-4), 0.0, 1.0);
       if (h > uS3dA) discard;
       float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
       vec3 clay = uS3dClay * (0.35 + lum * 1.1);
       float tex = smoothstep(uS3dB + 0.03, uS3dB - 0.03, h);
       gl_FragColor.rgb = mix(clay, gl_FragColor.rgb, tex);
       vec3 glow = mix(uS3dGlowA, uS3dGlowB, h);
       gl_FragColor.rgb += glow * (smoothstep(0.04, 0.0, abs(h - uS3dA)) * 1.6 + smoothstep(0.03, 0.0, abs(h - uS3dB)) * 0.9);`,
    );
  };
  m.customProgramCacheKey = () => "s3d-reveal-solid";
  m.needsUpdate = true;
}

function patchWire(m: THREE.Material, uniforms: Record<string, THREE.IUniform>): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying float vS3dY;`)
      .replace("#include <project_vertex>", `#include <project_vertex>\nvS3dY = (modelMatrix * vec4(transformed, 1.0)).y;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${REVEAL_UNIFORMS}`).replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
       float h = clamp((vS3dY - uS3dMinY) / max(uS3dMaxY - uS3dMinY, 1e-4), 0.0, 1.0);
       if (h < uS3dA - 0.02) discard;
       gl_FragColor.rgb = mix(uS3dGlowA, uS3dGlowB, h);`,
    );
  };
  m.customProgramCacheKey = () => "s3d-reveal-wire";
  m.needsUpdate = true;
}

export function startReveal(root: THREE.Object3D, tokens: ViewerTokens): RevealHandle {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const uniforms: Record<string, THREE.IUniform> = {
    uS3dA: { value: 0 },
    uS3dB: { value: 0 },
    uS3dMinY: { value: box.min.y },
    uS3dMaxY: { value: box.max.y },
    uS3dClay: { value: tokens.clay.clone() },
    uS3dGlowA: { value: tokens.accentFrom.clone() },
    uS3dGlowB: { value: tokens.accentTo.clone() },
  };
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const clones: THREE.Material[] = [];
  const overlays: THREE.Mesh[] = [];
  const wire = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.7, depthWrite: false });
  patchWire(wire, uniforms);
  clones.push(wire);

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.s3dOverlay) return;
    originals.set(mesh, mesh.material);
    const swap = (m: THREE.Material) => {
      const c = m.clone();
      patchSolid(c, uniforms);
      clones.push(c);
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    const skinned = mesh as THREE.SkinnedMesh;
    let overlay: THREE.Mesh;
    if (skinned.isSkinnedMesh) {
      const sm = new THREE.SkinnedMesh(mesh.geometry, wire);
      sm.bind(skinned.skeleton, skinned.bindMatrix);
      overlay = sm;
    } else overlay = new THREE.Mesh(mesh.geometry, wire);
    overlay.userData.s3dOverlay = true;
    overlay.renderOrder = 2;
    mesh.add(overlay);
    overlays.push(overlay);
  });

  return {
    update(t) {
      // Geometry grows bottom→top, then the texture follows a beat behind.
      const a = THREE.MathUtils.smoothstep(t, 0.05, 0.55) * 1.08;
      const b = THREE.MathUtils.smoothstep(t, 0.4, 1.0) * 1.08;
      uniforms.uS3dA!.value = a;
      uniforms.uS3dB!.value = b;
      wire.opacity = 0.75 * (1 - THREE.MathUtils.smoothstep(t, 0.5, 0.9));
    },
    dispose() {
      for (const o of overlays) o.removeFromParent();
      for (const [mesh, mat] of originals) mesh.material = mat;
      for (const c of clones) c.dispose();
    },
  };
}
