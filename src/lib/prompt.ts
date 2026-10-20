/**
 * Offline prompt helpers. "Enhance prompt" rewrites a short idea into a
 * description 3D generators respond well to: a clear subject, form, materials,
 * style and production constraints. Deterministic and instant — no LLM call.
 */
import type { Style } from "@/lib/backend/types";

const STYLE_PHRASES: Record<Style, string> = {
  realistic: "photorealistic, physically based materials, fine surface detail",
  stylized: "stylized game art, clean readable shapes, hand-painted textures",
  cartoon: "cartoon style, chunky proportions, bold flat colors, soft rounded forms",
  lowpoly: "low-poly, flat-shaded facets, simple solid colors, minimal geometry",
  voxel: "voxel art, built from uniform cubes, crisp blocky silhouette",
  sculpture: "sculpted figure, smooth stone-like surface, museum statue look",
};

const MATERIAL_HINTS: [RegExp, string][] = [
  [/\b(sword|axe|blade|dagger|armor|armour|helmet|shield|knight|robot|mech|gun|rifle)\b/i, "worn metal with subtle scratches"],
  [/\b(house|cottage|tower|castle|hut|cabin|temple|building)\b/i, "stone, timber and roof tiles"],
  [/\b(tree|plant|bush|flower|forest|mushroom)\b/i, "natural bark and foliage"],
  [/\b(dragon|creature|monster|beast|fox|wolf|cat|dog|bird|animal)\b/i, "detailed fur, scales or skin"],
  [/\b(car|truck|vehicle|bike|ship|boat|plane|spaceship)\b/i, "painted panels, glass and rubber"],
  [/\b(chair|table|sofa|lamp|desk|furniture|cabinet)\b/i, "wood grain and fabric"],
  [/\b(potion|crystal|gem|orb|magic|rune)\b/i, "glowing crystal and glass"],
];

const CONSTRAINTS = "single object, centered, full view, neutral pose, game-ready, clean topology, PBR textures";

export function enhancePrompt(prompt: string, style: Style): string {
  const base = prompt.trim().replace(/\s+/g, " ").replace(/[.,;]+$/, "");
  if (!base) return base;
  const lower = base.toLowerCase();
  const parts = [base.charAt(0).toUpperCase() + base.slice(1)];
  const material = MATERIAL_HINTS.find(([re]) => re.test(base))?.[1];
  if (material && !lower.includes(material.split(" ")[0]!)) parts.push(material);
  const stylePhrase = STYLE_PHRASES[style];
  if (!lower.includes(stylePhrase.split(",")[0]!)) parts.push(stylePhrase);
  if (!lower.includes("game-ready")) parts.push(CONSTRAINTS);
  return parts.join(", ");
}

export const SUGGESTIONS: string[] = [
  "A cute robot with a round head and antenna",
  "A medieval knight in ornate armor",
  "A cozy cottage with a red roof",
  "A glowing amethyst crystal cluster",
  "A fox sitting on its hind legs",
  "An enchanted sword with a gold hilt",
  "A vintage delivery truck",
  "A potted plant with large leaves",
];

export interface Template {
  id: "character" | "prop" | "weapon" | "building" | "creature" | "vehicle";
  label: string;
  prompt: string;
  style: Style;
}

export const TEMPLATES: Template[] = [
  { id: "character", label: "Character", prompt: "A heroic adventurer character in leather armor, standing in an A-pose", style: "stylized" },
  { id: "prop", label: "Prop", prompt: "A comfy armchair with velvet upholstery", style: "realistic" },
  { id: "weapon", label: "Weapon", prompt: "A fantasy longsword with an engraved blade and gold crossguard", style: "stylized" },
  { id: "building", label: "Building", prompt: "A small timber-framed cottage with a chimney", style: "lowpoly" },
  { id: "creature", label: "Creature", prompt: "A curious fox with a bushy tail", style: "stylized" },
  { id: "vehicle", label: "Vehicle", prompt: "A retro delivery truck with rounded fenders", style: "cartoon" },
];
