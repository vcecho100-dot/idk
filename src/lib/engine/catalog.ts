/**
 * Mock-mode sample catalog logic. The same catalog.json is embedded by the Rust
 * engine, so keyword matching here mirrors `src-tauri/src/providers/mock.rs`.
 */
import type { AnimationPreset } from "@/lib/backend/types";

export interface SampleEntry {
  id: string;
  file: string;
  name: string;
  category: "character" | "prop" | "weapon" | "building" | "creature" | "vehicle";
  keywords: string[];
  rigged: boolean;
  animationMap?: Partial<Record<AnimationPreset, string | null>>;
  procedural?: boolean;
  credit: string;
}

export interface Catalog {
  version: number;
  samples: SampleEntry[];
  defaults: string[];
  templates: Record<string, string>;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s_-]+/)
    .filter((w) => w.length > 1);
}

/** FNV-1a — a stable, tiny string hash shared with the Rust engine. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && /(ch|sh|x|s)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Picks the sample whose keywords best match the text. Exact word matches score
 * 3, prefix matches 1; ties go to the earliest catalog entry. With no match, a
 * stable hash of the text selects from `defaults` so the same prompt always
 * produces the same model.
 */
export function pickSample(catalog: Catalog, text: string): SampleEntry {
  const words = tokenize(text).map(singular);
  let best: SampleEntry | null = null;
  let bestScore = 0;
  for (const sample of catalog.samples) {
    let score = 0;
    for (const word of words) {
      for (const kw of sample.keywords) {
        if (word === kw) score += 3;
        else if (word.length >= 4 && (kw.startsWith(word) || word.startsWith(kw))) score += 1;
      }
    }
    if (score > bestScore) {
      best = sample;
      bestScore = score;
    }
  }
  if (best) return best;
  const pool = catalog.defaults.map((id) => catalog.samples.find((s) => s.id === id)).filter((s): s is SampleEntry => !!s);
  return pool[fnv1a(text.trim().toLowerCase()) % pool.length] ?? catalog.samples[0]!;
}

/** Variant tints (linear RGB multipliers). Variant 1 is always the untouched model. */
export const VARIANT_TINTS: readonly [number, number, number][] = [
  [1, 1, 1],
  [1, 0.8, 0.62],
  [0.66, 0.84, 1],
  [0.8, 1, 0.72],
];

export interface MaterialEdit {
  tint: [number, number, number] | null;
  metallic: number | null;
  roughness: number | null;
  emissive: [number, number, number] | null;
  matched: string[];
}

const COLOR_WORDS: Record<string, [number, number, number]> = {
  red: [1, 0.22, 0.2],
  crimson: [0.85, 0.12, 0.18],
  orange: [1, 0.55, 0.2],
  yellow: [1, 0.9, 0.3],
  gold: [1, 0.76, 0.33],
  golden: [1, 0.76, 0.33],
  green: [0.35, 0.85, 0.4],
  emerald: [0.2, 0.8, 0.5],
  teal: [0.2, 0.8, 0.75],
  cyan: [0.3, 0.9, 1],
  blue: [0.3, 0.5, 1],
  navy: [0.2, 0.25, 0.6],
  purple: [0.65, 0.4, 1],
  violet: [0.6, 0.4, 1],
  pink: [1, 0.5, 0.75],
  white: [1.3, 1.3, 1.3],
  black: [0.18, 0.18, 0.2],
  grey: [0.6, 0.6, 0.62],
  gray: [0.6, 0.6, 0.62],
  silver: [0.9, 0.92, 0.95],
  bronze: [0.8, 0.5, 0.25],
  copper: [0.95, 0.55, 0.38],
  brown: [0.6, 0.4, 0.25],
  wooden: [0.75, 0.5, 0.3],
  wood: [0.75, 0.5, 0.3],
  rusty: [0.75, 0.38, 0.2],
  rust: [0.75, 0.38, 0.2],
  marble: [1.15, 1.12, 1.08],
  stone: [0.7, 0.7, 0.68],
  ice: [0.75, 0.92, 1.1],
  icy: [0.75, 0.92, 1.1],
  lava: [1, 0.35, 0.15],
  candy: [1, 0.6, 0.85],
};

const SURFACE_WORDS: Record<string, { metallic?: number; roughness?: number; emissive?: boolean }> = {
  metal: { metallic: 1, roughness: 0.3 },
  metallic: { metallic: 1, roughness: 0.3 },
  chrome: { metallic: 1, roughness: 0.08 },
  steel: { metallic: 1, roughness: 0.32 },
  gold: { metallic: 1, roughness: 0.25 },
  golden: { metallic: 1, roughness: 0.25 },
  silver: { metallic: 1, roughness: 0.2 },
  bronze: { metallic: 1, roughness: 0.4 },
  copper: { metallic: 1, roughness: 0.35 },
  wood: { metallic: 0, roughness: 0.85 },
  wooden: { metallic: 0, roughness: 0.85 },
  stone: { metallic: 0, roughness: 0.95 },
  marble: { metallic: 0, roughness: 0.25 },
  plastic: { metallic: 0, roughness: 0.45 },
  rubber: { metallic: 0, roughness: 0.9 },
  matte: { roughness: 1 },
  glossy: { roughness: 0.12 },
  shiny: { roughness: 0.15 },
  polished: { roughness: 0.1 },
  rusty: { metallic: 0.4, roughness: 1 },
  ice: { metallic: 0, roughness: 0.1 },
  icy: { metallic: 0, roughness: 0.1 },
  neon: { emissive: true, roughness: 0.3 },
  glowing: { emissive: true },
  glow: { emissive: true },
  lava: { emissive: true, roughness: 0.9 },
  magic: { emissive: true },
};

/** Turns a retexture prompt into material edits ("rusty red metal" → tint + metal/rough). */
export function materialEditFromPrompt(prompt: string): MaterialEdit {
  const words = tokenize(prompt);
  const edit: MaterialEdit = { tint: null, metallic: null, roughness: null, emissive: null, matched: [] };
  for (const w of words) {
    const color = COLOR_WORDS[w];
    if (color && !edit.tint) {
      edit.tint = color;
      edit.matched.push(w);
    }
    const surface = SURFACE_WORDS[w];
    if (surface) {
      if (surface.metallic !== undefined) edit.metallic = surface.metallic;
      if (surface.roughness !== undefined) edit.roughness = surface.roughness;
      if (surface.emissive) edit.emissive = [0.6, 0.6, 0.6];
      if (!edit.matched.includes(w)) edit.matched.push(w);
    }
  }
  if (edit.emissive && edit.tint) edit.emissive = edit.tint.map((c) => Math.min(1, c * 0.7)) as [number, number, number];
  if (!edit.tint && !edit.metallic && !edit.roughness && !edit.emissive) {
    // Unknown words still produce a visible, deterministic recolor.
    const hue = (fnv1a(prompt.toLowerCase()) % 360) / 360;
    edit.tint = hslToRgb(hue, 0.55, 0.62);
  }
  return edit;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 1.6, f(8) * 1.6, f(4) * 1.6];
}

export interface MockStage {
  until: number;
  label: string;
}

export const GENERATE_STAGES: MockStage[] = [
  { until: 0.08, label: "Reading your prompt" },
  { until: 0.5, label: "Sculpting the shape" },
  { until: 0.8, label: "Painting textures" },
  { until: 0.93, label: "Cleaning up topology" },
  { until: 1, label: "Downloading model" },
];

export const REFINE_STAGES: MockStage[] = [
  { until: 0.1, label: "Preparing draft" },
  { until: 0.6, label: "Adding geometric detail" },
  { until: 0.9, label: "Baking PBR maps" },
  { until: 1, label: "Downloading model" },
];

export const RETEXTURE_STAGES: MockStage[] = [
  { until: 0.1, label: "Unwrapping UVs" },
  { until: 0.75, label: "Painting new textures" },
  { until: 1, label: "Downloading model" },
];

export const RIG_STAGES: MockStage[] = [
  { until: 0.2, label: "Detecting skeleton" },
  { until: 0.6, label: "Skinning mesh" },
  { until: 0.9, label: "Retargeting animation" },
  { until: 1, label: "Downloading model" },
];

export function stageAt(stages: MockStage[], progress: number): string {
  return (stages.find((s) => progress <= s.until) ?? stages[stages.length - 1]!).label;
}
