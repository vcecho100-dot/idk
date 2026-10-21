import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import type { ViewerTokens } from "./tokens";

/* ---------------------------------------------------------------------------
 * "The Shift", part 1 — a glowing point cloud that slowly gathers into a rough
 * shape while a model generates, then snaps onto the real surface on arrival.
 * ------------------------------------------------------------------------- */

const cloudVertex = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aShape;
  attribute vec3 aSurface;
  attribute float aSeed;
  uniform float uProgress;
  uniform float uGather;
  uniform float uTime;
  uniform float uSize;
  uniform float uOpacity;
  uniform float uHeight;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float p = clamp(uProgress * 1.2 - aSeed * 0.2, 0.0, 1.0);
    p = p * p * (3.0 - 2.0 * p);
    vec3 pos = mix(aStart, aShape, p);
    float wob = 1.0 - p * 0.75;
    pos += vec3(sin(uTime * 1.3 + aSeed * 40.0), cos(uTime * 1.1 + aSeed * 23.0), sin(uTime * 0.9 + aSeed * 11.0)) * 0.05 * uHeight * wob;
    pos = mix(pos, aSurface, uGather);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + aSeed) / -mv.z;
    vColor = mix(uColorA, uColorB, clamp(pos.y / uHeight, 0.0, 1.0));
    vAlpha = uOpacity * (0.25 + 0.75 * p) * (0.6 + 0.4 * sin(uTime * 2.0 + aSeed * 30.0));
  }
`;

const cloudFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * 1.8, a);
  }
`;

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CloudProps {
  count: number;
  /** 0..1 job progress. */
  progress: number;
  /** Expected model height (world units) — the cloud scales to it. */
  height: number;
  /** When set, the cloud gathers onto this model's surface and fades out. */
  target: THREE.Object3D | null;
  tokens: ViewerTokens;
  onDone?: () => void;
}

export function ShiftCloud({ count, progress, height, target, tokens, onDone }: CloudProps) {
  const geometry = useMemo(() => {
    const r = rand(1337);
    const start = new Float32Array(count * 3);
    const shape = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Start: a loose sphere of dust around the stage.
      const u = r() * 2 - 1;
      const th = r() * Math.PI * 2;
      const rad = height * (0.9 + r() * 1.6);
      const s = Math.sqrt(1 - u * u);
      start.set([Math.cos(th) * s * rad, height * 0.5 + u * rad * 0.7, Math.sin(th) * s * rad], i * 3);
      // Shape: a rough, slightly lumpy capsule — "something is forming".
      const v = r() * 2 - 1;
      const ph = r() * Math.PI * 2;
      const lump = 0.82 + 0.18 * Math.sin(ph * 3 + v * 5) + r() * 0.08;
      const sv = Math.sqrt(1 - v * v);
      shape.set([Math.cos(ph) * sv * height * 0.3 * lump, height * (0.5 + v * 0.47), Math.sin(ph) * sv * height * 0.3 * lump], i * 3);
      seed[i] = r();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(shape.slice(), 3));
    g.setAttribute("aStart", new THREE.BufferAttribute(start, 3));
    g.setAttribute("aShape", new THREE.BufferAttribute(shape, 3));
    g.setAttribute("aSurface", new THREE.BufferAttribute(shape.slice(), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), height * 3);
    return g;
  }, [count, height]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uProgress: { value: 0 },
          uGather: { value: 0 },
          uTime: { value: 0 },
          uSize: { value: 26 },
          uOpacity: { value: 0 },
          uHeight: { value: 1 },
          uColorA: { value: new THREE.Color() },
          uColorB: { value: new THREE.Color() },
        },
      }),
    [],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const gatherStart = useRef<number | null>(null);
  const done = useRef(false);

  // When the model arrives, sample its surface so every particle has a landing spot.
  useEffect(() => {
    if (!target) return;
    const meshes: THREE.Mesh[] = [];
    target.updateWorldMatrix(true, true);
    target.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.getAttribute("position")) meshes.push(m);
    });
    if (!meshes.length) return;
    const surface = geometry.getAttribute("aSurface") as THREE.BufferAttribute;
    const samplers = meshes.map((m) => new MeshSurfaceSampler(m).build());
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const k = i % samplers.length;
      samplers[k]!.sample(p);
      p.applyMatrix4(meshes[k]!.matrixWorld);
      surface.setXYZ(i, p.x, p.y, p.z);
    }
    surface.needsUpdate = true;
    gatherStart.current = null;
    done.current = false;
  }, [target, geometry, count]);

  useFrame((state, delta) => {
    const u = material.uniforms;
    u.uTime!.value += delta;
    u.uHeight!.value = height;
    u.uSize!.value = 26 * state.gl.getPixelRatio();
    (u.uColorA!.value as THREE.Color).copy(tokens.accentFrom);
    (u.uColorB!.value as THREE.Color).copy(tokens.accentTo);
    // Ease toward the real progress so jumps from the provider look smooth.
    u.uProgress!.value += (progress - u.uProgress!.value) * Math.min(1, delta * 2.5);
    if (!target) {
      u.uOpacity!.value = Math.min(1, u.uOpacity!.value + delta * 2);
      return;
    }
    gatherStart.current ??= state.clock.elapsedTime;
    const t = (state.clock.elapsedTime - gatherStart.current) / 0.55;
    u.uGather!.value = 1 - Math.pow(1 - Math.min(1, t), 3);
    u.uOpacity!.value = Math.max(0, 1 - Math.max(0, t - 0.55) * 2.2);
    if (u.uOpacity!.value <= 0 && !done.current) {
      done.current = true;
      onDone?.();
    }
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
