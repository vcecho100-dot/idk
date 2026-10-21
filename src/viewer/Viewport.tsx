import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useSettings } from "@/stores/settings";
import { useViewer } from "@/stores/viewer";
import type { MaterialEdits } from "@/stores/studio";
import { registerViewer } from "./bridge";
import { Lighting } from "./Lighting";
import { applyRenderMode } from "./materials";
import { startReveal, type RevealHandle } from "./reveal";
import { ShiftCloud } from "./Shift";
import { useViewerTokens, type ViewerTokens } from "./tokens";
import type { ViewModel } from "./useModel";

const QUALITY = {
  low: { dpr: 1, ao: false, bloom: false, shadowRes: 256, envRes: 128, points: 2500, msaa: 0 },
  medium: { dpr: 1.25, ao: false, bloom: true, shadowRes: 512, envRes: 256, points: 4500, msaa: 4 },
  high: { dpr: 1.75, ao: true, bloom: true, shadowRes: 1024, envRes: 256, points: 7000, msaa: 4 },
  ultra: { dpr: 2, ao: true, bloom: true, shadowRes: 1024, envRes: 512, points: 10000, msaa: 8 },
} as const;

const HERO_DIR = new THREE.Vector3(0.62, 0.38, 0.69).normalize();

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/* -------------------------------- Background -------------------------------- */

function Background({ tokens }: { tokens: ViewerTokens }) {
  const background = useViewer((s) => s.background);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (background === "transparent" || background === "environment") {
      if (background === "transparent") scene.background = null;
      invalidate();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    if (background === "solid") {
      ctx.fillStyle = `#${tokens.bgSolid.getHexString(THREE.SRGBColorSpace)}`;
      ctx.fillRect(0, 0, 2, 256);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, `#${tokens.bgTop.getHexString(THREE.SRGBColorSpace)}`);
      g.addColorStop(1, `#${tokens.bgBottom.getHexString(THREE.SRGBColorSpace)}`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 2, 256);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    invalidate();
    return () => {
      tex.dispose();
      if (scene.background === tex) scene.background = null;
    };
  }, [background, tokens, scene, invalidate]);
  return null;
}

/* ----------------------------------- Model ----------------------------------- */

function applyEdits(root: THREE.Object3D, edits: MaterialEdits | undefined): void {
  const tint = new THREE.Color(edits?.tint ?? "#ffffff");
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.s3dOverlay) return;
    const mats = (mesh.userData.s3dOriginal ?? mesh.material) as THREE.Material | THREE.Material[];
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const s = m as THREE.MeshStandardMaterial;
      if (!s.isMeshStandardMaterial) continue;
      const base = (s.userData.s3dBase ??= { color: s.color.clone(), roughness: s.roughness, metalness: s.metalness, emissive: s.emissive.clone() }) as {
        color: THREE.Color;
        roughness: number;
        metalness: number;
        emissive: THREE.Color;
      };
      s.color.copy(base.color).lerp(base.color.clone().multiply(tint), edits?.tintAmount ?? 0);
      s.roughness = edits?.roughness ?? base.roughness;
      s.metalness = edits?.metalness ?? base.metalness;
      s.emissive.copy(base.emissive).add(tint.clone().multiplyScalar(edits?.emissive ?? 0));
    }
  });
}

function ModelView({
  model,
  tokens,
  visible,
  edits,
  reveal,
  onRevealDone,
  objectRef,
}: {
  model: ViewModel;
  tokens: ViewerTokens;
  visible: boolean;
  edits?: MaterialEdits;
  reveal: boolean;
  onRevealDone?: () => void;
  objectRef?: (o: THREE.Object3D | null) => void;
}) {
  const renderMode = useViewer((s) => s.renderMode);
  const channel = useViewer((s) => s.mapChannel);
  const clip = useViewer((s) => s.clip);
  const playing = useViewer((s) => s.playing);
  const invalidate = useThree((s) => s.invalidate);
  const mixer = useMemo(() => new THREE.AnimationMixer(model.root), [model.root]);
  const revealRef = useRef<{ handle: RevealHandle; start: number } | null>(null);
  const [revealing, setRevealing] = useState(reveal);
  const [prevReveal, setPrevReveal] = useState(reveal);
  if (reveal !== prevReveal) {
    setPrevReveal(reveal);
    if (reveal) setRevealing(true);
  }

  useEffect(() => {
    objectRef?.(model.root);
    return () => objectRef?.(null);
  }, [model.root, objectRef]);

  // Render mode (skipped while The Shift reveal owns the materials).
  useEffect(() => {
    if (revealing) return;
    const r = applyRenderMode(model.root, renderMode, channel, tokens);
    invalidate();
    return () => r.dispose();
  }, [model.root, renderMode, channel, tokens, revealing, invalidate]);

  useEffect(() => {
    applyEdits(model.root, edits);
    invalidate();
  }, [model.root, edits, invalidate]);

  // Animation playback.
  useEffect(() => {
    mixer.stopAllAction();
    const c = model.clips.find((x) => x.name === clip) ?? model.clips[0];
    if (c) {
      const action = mixer.clipAction(c);
      action.reset().play();
      action.paused = !playing;
    }
    invalidate();
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, model.clips, clip, playing, invalidate]);

  useEffect(() => () => void mixer.uncacheRoot(model.root), [mixer, model.root]);

  useFrame((state, delta) => {
    if (playing && model.clips.length) mixer.update(Math.min(delta, 0.1));
    const r = revealRef.current;
    if (r) {
      const t = (state.clock.elapsedTime - r.start) / 1.15;
      r.handle.update(Math.min(1, t));
      if (t >= 1) {
        r.handle.dispose();
        revealRef.current = null;
        setRevealing(false);
        onRevealDone?.();
      }
    }
  });

  // "The Shift" reveal: wireframe → clay → textured over ~1s.
  const clock = useThree((s) => s.clock);
  useEffect(() => {
    if (!reveal) return;
    const start = clock.elapsedTime + 0.25;
    const handle = startReveal(model.root, tokens);
    handle.update(0);
    revealRef.current = { handle, start };
    invalidate();
    return () => {
      if (revealRef.current?.handle === handle) {
        handle.dispose();
        revealRef.current = null;
      }
    };
  }, [reveal, model.root, tokens, clock, invalidate]);

  const { box } = model;
  const center = box.getCenter(new THREE.Vector3());
  return (
    <group position={[-center.x, -box.min.y, -center.z]} visible={visible}>
      <primitive object={model.root} />
    </group>
  );
}

/* ---------------------------------- Camera ---------------------------------- */

function CameraRig({ radius, height, versionKey }: { radius: number; height: number; versionKey: string | null }) {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const invalidate = useThree((s) => s.invalidate);
  const frameRequest = useViewer((s) => s.frameRequest);
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number } | null>(null);
  const first = useRef(true);

  const goal = useMemo(() => {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.05;
    const target = new THREE.Vector3(0, height * 0.46, 0);
    return { target, pos: target.clone().addScaledVector(HERO_DIR, dist) };
  }, [radius, height, camera.fov]);

  useEffect(() => {
    camera.near = Math.max(radius / 200, 0.001);
    camera.far = radius * 200;
    camera.updateProjectionMatrix();
    if (!controls) return;
    controls.minDistance = radius * 0.25;
    controls.maxDistance = radius * 25;
    if (first.current) {
      first.current = false;
      camera.position.copy(goal.pos);
      controls.target.copy(goal.target);
      controls.update();
      invalidate();
      return;
    }
    anim.current = { from: camera.position.clone(), to: goal.pos, fromT: controls.target.clone(), toT: goal.target, t: 0 };
    invalidate();
    // Re-frame when the model or its size changes, or on request.
  }, [goal, frameRequest, versionKey, controls, camera, radius, invalidate]);

  useFrame((_, delta) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + delta / 0.45);
    const e = 1 - Math.pow(1 - a.t, 3);
    camera.position.lerpVectors(a.from, a.to, e);
    controls.target.lerpVectors(a.fromT, a.toT, e);
    controls.update();
    if (a.t >= 1) anim.current = null;
    invalidate();
  });
  return null;
}

/* ------------------------------- Frame driver ------------------------------- */

/** Continuous rendering only while something animates, capped at the FPS setting. */
function FrameDriver({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const fps = useSettings((s) => s.settings.fpsCap);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const interval = fps > 0 ? 1000 / fps : 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!interval || t - last >= interval - 2) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, fps, invalidate]);
  return null;
}

/* ---------------------------------- Compare ---------------------------------- */

function CompareRenderer({ a, b, split }: { a: THREE.Object3D | null; b: THREE.Object3D | null; split: number }) {
  useFrame(({ gl, scene, camera, size }) => {
    if (!a || !b) {
      gl.render(scene, camera);
      return;
    }
    const x = Math.round(size.width * split);
    gl.autoClear = false;
    gl.setScissorTest(true);
    gl.clear();
    const pa = a.parent!;
    const pb = b.parent!;
    pa.visible = true;
    pb.visible = false;
    gl.setScissor(0, 0, x, size.height);
    gl.render(scene, camera);
    pa.visible = false;
    pb.visible = true;
    gl.setScissor(x, 0, size.width - x, size.height);
    gl.render(scene, camera);
    gl.setScissorTest(false);
    gl.autoClear = true;
    pa.visible = pb.visible = true;
  }, 1);
  return null;
}

/* ----------------------------------- Bridge ----------------------------------- */

function Bridge({ target, radius, rootRef }: { target: THREE.Vector3; radius: number; rootRef: React.RefObject<THREE.Object3D | null> }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const shots = useRef<((b: Blob) => void)[]>([]);

  useFrame(() => {
    if (!shots.current.length) return;
    const pending = shots.current.splice(0);
    gl.domElement.toBlob((blob) => blob && pending.forEach((r) => r(blob)), "image/png");
  }, 2);

  useEffect(() => {
    const heroCamera = (aspect: number) => {
      const cam = camera.clone();
      cam.aspect = aspect;
      const dist = (radius / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.0;
      cam.position.copy(target).addScaledVector(HERO_DIR, dist);
      cam.lookAt(target);
      cam.updateProjectionMatrix();
      return cam;
    };
    registerViewer({
      root: () => rootRef.current,
      invalidate,
      screenshot: () =>
        new Promise<Blob>((resolve) => {
          shots.current.push(resolve);
          invalidate();
        }),
      thumbnail: (w = 480, h = 360) =>
        new Promise<Blob>((resolve, reject) => {
          const canvas = gl.domElement;
          gl.render(scene, heroCamera(canvas.width / canvas.height));
          const out = document.createElement("canvas");
          out.width = w;
          out.height = h;
          const ctx = out.getContext("2d")!;
          // Center-crop the hero frame into the thumbnail's aspect.
          const scale = Math.max(w / canvas.width, h / canvas.height);
          const sw = w / scale;
          const sh = h / scale;
          ctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, w, h);
          gl.render(scene, camera);
          invalidate();
          out.toBlob((b) => (b ? resolve(b) : reject(new Error("Thumbnail capture failed"))), "image/webp", 0.86);
        }),
      renderTurntable: async ({ width, height, frames, onFrame, signal }) => {
        const prevSize = new THREE.Vector2();
        gl.getSize(prevSize);
        const prevRatio = gl.getPixelRatio();
        gl.setPixelRatio(1);
        gl.setSize(width, height, false);
        const cam = heroCamera(width / height);
        const offset = cam.position.clone().sub(target);
        try {
          for (let i = 0; i < frames; i++) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const angle = (i / frames) * Math.PI * 2;
            cam.position.copy(target).add(offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle));
            cam.lookAt(target);
            gl.render(scene, cam);
            await onFrame(gl.domElement, i);
          }
        } finally {
          gl.setPixelRatio(prevRatio);
          gl.setSize(prevSize.x, prevSize.y, false);
          invalidate();
        }
      },
    });
    return () => registerViewer(null);
  }, [gl, scene, camera, invalidate, target, radius, rootRef, size]);
  return null;
}

/* ----------------------------------- Scene ----------------------------------- */

export interface ViewportProps {
  model: ViewModel | null;
  compareModel: ViewModel | null;
  generating: { progress: number } | null;
  reveal: boolean;
  onRevealDone?: () => void;
  edits?: MaterialEdits;
}

function Scene({ model, compareModel, generating, reveal, onRevealDone, edits }: ViewportProps) {
  const tokens = useViewerTokens();
  const quality = QUALITY[useSettings((s) => s.settings.viewportQuality)];
  const lighting = useViewer((s) => s.lighting);
  const background = useViewer((s) => s.background);
  const showGrid = useViewer((s) => s.showGrid);
  const turntable = useViewer((s) => s.turntable);
  const playing = useViewer((s) => s.playing);
  const split = useViewer((s) => s.split);
  const setDpr = useThree((s) => s.setDpr);
  const rootRef = useRef<THREE.Object3D | null>(null);
  const [a, setA] = useState<THREE.Object3D | null>(null);
  const [cloudDone, setCloudDone] = useState(!generating);
  const [revealActive, setRevealActive] = useState(reveal);

  const isGenerating = Boolean(generating);
  const [prev, setPrev] = useState({ isGenerating, reveal });
  if (prev.isGenerating !== isGenerating || prev.reveal !== reveal) {
    setPrev({ isGenerating, reveal });
    if (isGenerating) setCloudDone(false);
    setRevealActive(reveal);
  }

  const radius = model?.radius ?? 0.9;
  const height = model?.size.y ?? 1.6;
  const comparing = Boolean(compareModel && model);
  const cloudVisible = !cloudDone && (Boolean(generating) || reveal);
  const animated = Boolean(model?.clips.length && playing);
  const cell = niceStep(radius / 6);
  const target = useMemo(() => new THREE.Vector3(0, height * 0.46, 0), [height]);

  return (
    <>
      <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(quality.dpr)} />
      <Background tokens={tokens} />
      <Lighting preset={lighting} background={background === "environment"} resolution={quality.envRes} />
      {showGrid && (
        <Grid
          infiniteGrid
          cellSize={cell}
          sectionSize={cell * 5}
          cellColor={tokens.gridMinor}
          sectionColor={tokens.gridMajor}
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={radius * 14}
          fadeStrength={1.6}
          position={[0, -0.0005, 0]}
        />
      )}
      {model && (
        <ContactShadows
          key={`${model.versionId}-${quality.shadowRes}`}
          position={[0, 0.0008, 0]}
          scale={radius * 5}
          far={Math.max(height * 1.4, 0.2)}
          blur={2.4}
          opacity={tokens.dark ? 0.6 : 0.38}
          resolution={quality.shadowRes}
          frames={animated ? Infinity : 1}
        />
      )}
      {model && (
        <ModelView
          key={model.versionId}
          model={model}
          tokens={tokens}
          visible={!generating}
          edits={edits}
          reveal={reveal}
          onRevealDone={() => {
            setRevealActive(false);
            onRevealDone?.();
          }}
          objectRef={(o) => {
            rootRef.current = o;
            setA(o);
          }}
        />
      )}
      {compareModel && <ModelView key={`cmp-${compareModel.versionId}`} model={compareModel} tokens={tokens} visible reveal={false} objectRef={() => {}} />}
      {cloudVisible && (
        <ShiftCloud
          count={quality.points}
          progress={generating?.progress ?? 1}
          height={height}
          target={!generating && model ? model.root : null}
          tokens={tokens}
          onDone={() => setCloudDone(true)}
        />
      )}
      <CameraRig radius={radius} height={height} versionKey={model?.versionId ?? null} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.09} autoRotate={turntable} autoRotateSpeed={2.2} maxPolarAngle={Math.PI * 0.94} />
      <FrameDriver active={turntable || animated || cloudVisible || revealActive} />
      <Bridge target={target} radius={radius} rootRef={rootRef} />
      {comparing ? (
        <CompareRenderer a={compareModel ? findRoot(compareModel) : null} b={a} split={split} />
      ) : (
        (quality.ao || quality.bloom) && (
          <EffectComposer multisampling={quality.msaa} enableNormalPass={false}>
            <>{quality.ao ? <N8AO halfRes={quality !== QUALITY.ultra} aoRadius={radius * 0.35} distanceFalloff={1} intensity={2.2} quality="medium" /> : null}</>
            <>{quality.bloom ? <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={0.45} /> : null}</>
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          </EffectComposer>
        )
      )}
    </>
  );
}

function findRoot(m: ViewModel): THREE.Object3D {
  return m.root;
}

export function Viewport({ children, className, ...props }: ViewportProps & { children?: ReactNode; className?: string }) {
  const quality = QUALITY[useSettings((s) => s.settings.viewportQuality)];
  const background = useViewer((s) => s.background);
  return (
    <div className={className} data-background={background}>
      <Canvas
        frameloop="demand"
        dpr={[1, quality.dpr]}
        gl={{ antialias: quality.msaa === 0, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: false }}
        camera={{ fov: 35, near: 0.01, far: 1000, position: [2.5, 1.6, 2.8] }}
        className="!absolute inset-0"
      >
        <Suspense fallback={null}>
          <Scene {...props} />
        </Suspense>
      </Canvas>
      {children}
    </div>
  );
}
