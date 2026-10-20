import { Environment, Lightformer } from "@react-three/drei";
import type { LightingPreset } from "@/stores/viewer";

/**
 * Procedural image-based lighting: each preset bakes a handful of area lights
 * ("light formers") into an environment map once — no HDRI files, no network.
 * These colors are lighting data (not UI chrome), so they live here rather than in tokens.
 */
type Vec3 = [number, number, number];
interface Former {
  form: "rect" | "circle" | "ring";
  position: Vec3;
  scale: number | [number, number, number];
  intensity: number;
  color?: string;
}
interface Rig {
  sky: string;
  formers: Former[];
  key: { position: Vec3; intensity: number; color: string };
  ambient: number;
  exposure: number;
}

const RIGS: Record<LightingPreset, Rig> = {
  studio: {
    sky: "#141418",
    formers: [
      { form: "rect", position: [-5, 4, 4], scale: [5, 3, 1], intensity: 3 },
      { form: "rect", position: [6, 2, 2], scale: [4, 3, 1], intensity: 0.9 },
      { form: "rect", position: [0, 4, -7], scale: [8, 2, 1], intensity: 2.2 },
      { form: "circle", position: [0, 8, 0], scale: 4, intensity: 1.4 },
      { form: "rect", position: [0, -4, 0], scale: [10, 10, 1], intensity: 0.15 },
    ],
    key: { position: [3, 6, 4], intensity: 1.1, color: "#ffffff" },
    ambient: 0.05,
    exposure: 1,
  },
  soft: {
    sky: "#3a3a42",
    formers: [
      { form: "ring", position: [0, 5, 0], scale: 8, intensity: 1.1 },
      { form: "rect", position: [0, 2, 7], scale: [10, 4, 1], intensity: 0.9 },
      { form: "rect", position: [0, 2, -7], scale: [10, 4, 1], intensity: 0.7 },
      { form: "rect", position: [7, 2, 0], scale: [10, 4, 1], intensity: 0.7 },
      { form: "rect", position: [-7, 2, 0], scale: [10, 4, 1], intensity: 0.7 },
      { form: "circle", position: [0, 9, 0], scale: 6, intensity: 1.2 },
    ],
    key: { position: [2, 6, 3], intensity: 0.35, color: "#ffffff" },
    ambient: 0.15,
    exposure: 1,
  },
  sunset: {
    sky: "#1d1022",
    formers: [
      { form: "rect", position: [-8, 1.5, 3], scale: [7, 2, 1], intensity: 4, color: "#ff8a3d" },
      { form: "rect", position: [0, 8, 0], scale: [12, 12, 1], intensity: 0.45, color: "#ffb38a" },
      { form: "rect", position: [7, 2, -3], scale: [4, 3, 1], intensity: 1.3, color: "#7c5cff" },
      { form: "rect", position: [0, -3, 0], scale: [12, 12, 1], intensity: 0.12, color: "#ff6a3d" },
    ],
    key: { position: [-6, 2.5, 3], intensity: 1.6, color: "#ffb070" },
    ambient: 0.03,
    exposure: 1.05,
  },
  night: {
    sky: "#05060a",
    formers: [
      { form: "rect", position: [4, 6, 4], scale: [3, 3, 1], intensity: 1.6, color: "#a9c1ff" },
      { form: "rect", position: [-3, 3, -6], scale: [6, 1, 1], intensity: 2, color: "#22d3ee" },
      { form: "rect", position: [0, 9, 0], scale: [10, 10, 1], intensity: 0.12, color: "#3a4a7a" },
    ],
    key: { position: [4, 6, 4], intensity: 0.55, color: "#a9c1ff" },
    ambient: 0.02,
    exposure: 1.1,
  },
  neon: {
    sky: "#08060c",
    formers: [
      { form: "rect", position: [-6, 1, 1], scale: [1, 8, 1], intensity: 6, color: "#ff3cac" },
      { form: "rect", position: [6, 1, 1], scale: [1, 8, 1], intensity: 6, color: "#22d3ee" },
      { form: "rect", position: [0, 2, -6], scale: [8, 1, 1], intensity: 3, color: "#8b5cf6" },
      { form: "rect", position: [0, 6, 6], scale: [6, 1, 1], intensity: 0.8, color: "#ffffff" },
    ],
    key: { position: [0, 5, 5], intensity: 0, color: "#ffffff" },
    ambient: 0.02,
    exposure: 1,
  },
  outdoor: {
    sky: "#9cc7ef",
    formers: [
      { form: "rect", position: [0, 10, 0], scale: [20, 20, 1], intensity: 1.2, color: "#cfe8ff" },
      { form: "circle", position: [6, 8, 5], scale: 1.2, intensity: 12, color: "#fff1d6" },
      { form: "rect", position: [0, -3, 0], scale: [20, 20, 1], intensity: 0.4, color: "#8c7a5a" },
      { form: "ring", position: [0, 0, 0], scale: 14, intensity: 0.4, color: "#bcd8f0" },
    ],
    key: { position: [6, 8, 5], intensity: 1.6, color: "#fff1d6" },
    ambient: 0.05,
    exposure: 1,
  },
};

export function Lighting({ preset, background, resolution = 256 }: { preset: LightingPreset; background: boolean; resolution?: number }) {
  const rig = RIGS[preset];
  return (
    <>
      <Environment key={preset} resolution={resolution} frames={1} background={background} backgroundBlurriness={0.55}>
        <color attach="background" args={[rig.sky]} />
        {rig.formers.map((f, i) => (
          <Lightformer key={i} form={f.form} position={f.position} scale={f.scale} intensity={f.intensity} color={f.color ?? "#ffffff"} />
        ))}
      </Environment>
      {rig.key.intensity > 0 && <directionalLight position={rig.key.position} intensity={rig.key.intensity} color={rig.key.color} />}
      <ambientLight intensity={rig.ambient} />
    </>
  );
}
