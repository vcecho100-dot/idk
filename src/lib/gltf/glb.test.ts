import { describe, expect, it } from "vitest";
import { applyMaterialEdit, buildGlb, computeStats, draftGlb, imageSize, isGlb, parseGlb, tintGlb } from "./glb";
import { sampleBytes, triangleGlb } from "@/test/fixtures";

describe("glb container", () => {
  it("round-trips and pads to 4 bytes", () => {
    const bytes = triangleGlb();
    expect(isGlb(bytes)).toBe(true);
    expect(bytes.length % 4).toBe(0);
    const again = buildGlb(parseGlb(bytes));
    expect(parseGlb(again).json.meshes?.length).toBe(1);
  });

  it("rejects garbage and truncated files", () => {
    expect(() => parseGlb(new TextEncoder().encode("definitely not a model"))).toThrow();
    const bytes = triangleGlb();
    expect(() => parseGlb(bytes.subarray(0, bytes.length - 8))).toThrow();
  });

  it("computes stats like the Rust engine", () => {
    const s = computeStats(triangleGlb());
    expect(s).toMatchObject({ triangles: 1, vertices: 3, materials: 1, hasSkin: false });
  });

  it("reads real sample stats (animations, skins, textures)", () => {
    const fox = computeStats(sampleBytes("Fox.glb"));
    expect(fox.hasSkin).toBe(true);
    expect(fox.animations).toEqual(expect.arrayContaining(["Survey", "Walk", "Run"]));
    expect(fox.maxTextureSize).toBeGreaterThan(0);
  });
});

describe("material edits", () => {
  it("draft drops detail maps", () => {
    const m = parseGlb(draftGlb(triangleGlb())).json.materials?.[0];
    expect(m?.normalTexture).toBeUndefined();
  });

  it("tint multiplies base color", () => {
    const m = parseGlb(tintGlb(triangleGlb(), [1, 0.5, 0.5])).json.materials?.[0];
    expect(m?.pbrMetallicRoughness?.baseColorFactor?.[1]).toBeCloseTo(0.5);
  });

  it("applies retexture edits", () => {
    const out = applyMaterialEdit(triangleGlb(), { tint: null, metallic: 1, roughness: 0.2, emissive: null });
    const pbr = parseGlb(out).json.materials?.[0]?.pbrMetallicRoughness;
    expect(pbr?.metallicFactor).toBe(1);
    expect(pbr?.roughnessFactor).toBe(0.2);
  });
});

describe("image headers", () => {
  it("reads PNG dimensions", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(png.buffer);
    v.setUint32(16, 640);
    v.setUint32(20, 480);
    expect(imageSize(png)).toEqual({ width: 640, height: 480 });
  });
});
