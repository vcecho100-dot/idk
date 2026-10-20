import * as THREE from "three";
import type { MapChannel, RenderMode } from "@/stores/viewer";
import type { ViewerTokens } from "./tokens";

const ORIGINAL = "s3dOriginal";
const OVERLAY = "s3dOverlay";

type Mat = THREE.Material & Partial<THREE.MeshStandardMaterial>;

export interface RenderModeResult {
  /** Channels that exist on at least one material (for the maps picker). */
  missing: boolean;
  dispose(): void;
}

/* --------------------------------- Checker -------------------------------- */

let checker: { key: string; tex: THREE.CanvasTexture } | null = null;

function checkerTexture(t: ViewerTokens): THREE.CanvasTexture {
  const key = [t.checkerA, t.checkerB, t.accentFrom, t.accentTo].map((c) => c.getHexString()).join("");
  if (checker?.key === key) return checker.tex;
  checker?.tex.dispose();
  const size = 1024;
  const cells = 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = `#${((x + y) % 2 ? t.checkerA : t.checkerB).getHexString(THREE.SRGBColorSpace)}`;
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  // A diagonal accent wash reveals UV direction and stretching.
  const grad = ctx.createLinearGradient(0, size, size, 0);
  grad.addColorStop(0, `#${t.accentFrom.getHexString(THREE.SRGBColorSpace)}`);
  grad.addColorStop(1, `#${t.accentTo.getHexString(THREE.SRGBColorSpace)}`);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = grad;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if ((x + y) % 2) ctx.fillRect(x * step + 6, y * step + 6, step - 12, step - 12);
    }
  }
  ctx.globalAlpha = 0.9;
  ctx.font = `600 ${Math.round(step * 0.28)}px "Geist Variable", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const light = `#${t.wire.getHexString(THREE.SRGBColorSpace)}`;
  const dark = `#${t.checkerA.getHexString(THREE.SRGBColorSpace)}`;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 ? light : dark;
      ctx.fillText(`${String.fromCharCode(65 + x)}${cells - y}`, x * step + step / 2, y * step + step / 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.flipY = false;
  checker = { key, tex };
  return tex;
}

/* ------------------------------ Channel viewer ------------------------------ */

const CHANNEL_SOURCE: Record<MapChannel, keyof THREE.MeshStandardMaterial> = {
  baseColor: "map",
  normal: "normalMap",
  roughness: "roughnessMap",
  metalness: "metalnessMap",
  occlusion: "aoMap",
  emissive: "emissiveMap",
};

/** Shows one texture channel as stored (data maps are not gamma-shifted). */
function channelMaterial(orig: Mat, channel: MapChannel): { mat: THREE.Material; missing: boolean } {
  const tex = orig[CHANNEL_SOURCE[channel]] as THREE.Texture | null | undefined;
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false, side: orig.side ?? THREE.FrontSide });
  if (!tex) {
    // No texture: visualize the scalar/color factor instead.
    const factor =
      channel === "roughness"
        ? new THREE.Color().setScalar(orig.roughness ?? 1)
        : channel === "metalness"
          ? new THREE.Color().setScalar(orig.metalness ?? 0)
          : channel === "baseColor"
            ? (orig.color?.clone() ?? new THREE.Color(1, 1, 1))
            : channel === "emissive"
              ? (orig.emissive?.clone() ?? new THREE.Color(0, 0, 0))
              : channel === "normal"
                ? new THREE.Color(0.5, 0.5, 1).convertSRGBToLinear()
                : new THREE.Color(1, 1, 1);
    mat.color = factor;
    return { mat, missing: true };
  }
  mat.map = tex;
  const swizzle = channel === "roughness" ? "vec3(t.g)" : channel === "metalness" ? "vec3(t.b)" : channel === "occlusion" ? "vec3(t.r)" : "t.rgb";
  const data = channel !== "baseColor" && channel !== "emissive";
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP
        vec4 t = texture2D( map, vMapUv );
        vec3 v = ${swizzle};
        ${data ? "diffuseColor.rgb = sRGBTransferEOTF( vec4( v, 1.0 ) ).rgb;" : "diffuseColor.rgb = v;"}
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => `s3d-channel-${channel}`;
  return { mat, missing: false };
}

/* ------------------------------- Mode swapping ------------------------------- */

function eachMesh(root: THREE.Object3D, fn: (m: THREE.Mesh) => void): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData[OVERLAY]) fn(m);
  });
}

function originalOf(mesh: THREE.Mesh): THREE.Material | THREE.Material[] {
  return (mesh.userData[ORIGINAL] ??= mesh.material) as THREE.Material | THREE.Material[];
}

function mapMaterials(orig: THREE.Material | THREE.Material[], fn: (m: Mat) => THREE.Material): THREE.Material | THREE.Material[] {
  return Array.isArray(orig) ? orig.map((m) => fn(m as Mat)) : fn(orig as Mat);
}

/**
 * Swaps every mesh to the requested render mode. Original materials are kept on
 * userData and restored for "textured"; derived materials are disposed on cleanup.
 */
export function applyRenderMode(root: THREE.Object3D, mode: RenderMode, channel: MapChannel, tokens: ViewerTokens): RenderModeResult {
  const created = new Set<THREE.Material>();
  const overlays: THREE.Mesh[] = [];
  const cache = new Map<THREE.Material, THREE.Material>();
  let wireMats: { occluder: THREE.Material; wire: THREE.Material } | null = null;
  let missing = false;
  const derive = (m: Mat, make: (m: Mat) => THREE.Material) => {
    let d = cache.get(m);
    if (!d) {
      d = make(m);
      cache.set(m, d);
      created.add(d);
    }
    return d;
  };

  eachMesh(root, (mesh) => {
    const orig = originalOf(mesh);
    const hasUv = Boolean(mesh.geometry.getAttribute("uv"));
    switch (mode) {
      case "textured":
        mesh.material = orig;
        break;
      case "clay":
        mesh.material = mapMaterials(orig, (m) =>
          derive(m, (o) => new THREE.MeshStandardMaterial({ color: tokens.clay, roughness: 0.62, metalness: 0, normalMap: o.normalMap ?? null, normalScale: o.normalScale, side: o.side })),
        );
        break;
      case "normals":
        mesh.material = mapMaterials(orig, (m) => derive(m, (o) => new THREE.MeshNormalMaterial({ normalMap: o.normalMap ?? null, normalScale: o.normalScale, side: o.side })));
        break;
      case "uv":
        if (!hasUv) missing = true;
        mesh.material = mapMaterials(orig, (m) =>
          derive(m, (o) =>
            hasUv ? new THREE.MeshStandardMaterial({ map: checkerTexture(tokens), roughness: 0.75, side: o.side }) : new THREE.MeshStandardMaterial({ color: tokens.clay, roughness: 0.9, side: o.side }),
          ),
        );
        break;
      case "maps":
        mesh.material = mapMaterials(orig, (m) =>
          derive(m, (o) => {
            const r = channelMaterial(o, channel);
            if (r.missing) missing = true;
            return r.mat;
          }),
        );
        break;
      case "wireframe": {
        // Hidden-line look: a solid occluder plus a wireframe overlay sharing the geometry.
        wireMats ??= (() => {
          const occluder = new THREE.MeshBasicMaterial({ color: tokens.bgBottom.clone().lerp(tokens.clay, 0.06), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
          const wire = new THREE.MeshBasicMaterial({ color: tokens.wire, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false });
          created.add(occluder);
          created.add(wire);
          return { occluder, wire };
        })();
        mesh.material = wireMats.occluder;
        const wire = wireMats.wire;
        const skinned = mesh as THREE.SkinnedMesh;
        const overlay = skinned.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, wire) : new THREE.Mesh(mesh.geometry, wire);
        if (skinned.isSkinnedMesh) (overlay as THREE.SkinnedMesh).bind(skinned.skeleton, skinned.bindMatrix);
        overlay.morphTargetInfluences = mesh.morphTargetInfluences;
        overlay.morphTargetDictionary = mesh.morphTargetDictionary;
        overlay.userData[OVERLAY] = true;
        overlay.renderOrder = 1;
        overlay.frustumCulled = mesh.frustumCulled;
        mesh.add(overlay);
        overlays.push(overlay);
        break;
      }
    }
  });

  return {
    missing,
    dispose() {
      for (const o of overlays) o.removeFromParent();
      eachMesh(root, (mesh) => {
        if (mesh.userData[ORIGINAL]) mesh.material = mesh.userData[ORIGINAL] as THREE.Material;
      });
      for (const m of created) m.dispose();
    },
  };
}

/** Which texture channels any material in the model actually has. */
export function availableChannels(root: THREE.Object3D): Set<MapChannel> {
  const out = new Set<MapChannel>();
  eachMesh(root, (mesh) => {
    const mats = originalOf(mesh);
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      for (const [ch, key] of Object.entries(CHANNEL_SOURCE) as [MapChannel, keyof THREE.MeshStandardMaterial][]) {
        if ((m as Mat)[key]) out.add(ch);
      }
    }
  });
  return out;
}
