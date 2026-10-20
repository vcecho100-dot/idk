import { describe, expect, it } from "vitest";
import { fnv1a, materialEditFromPrompt, pickSample, stageAt, GENERATE_STAGES, type Catalog } from "./catalog";
import { sampleBytes } from "@/test/fixtures";

const catalog = JSON.parse(new TextDecoder().decode(sampleBytes("catalog.json"))) as Catalog;

describe("sample picking (must match the Rust mock provider)", () => {
  it("matches keywords, plurals and prefixes", () => {
    expect(pickSample(catalog, "a cute fox").id).toBe("fox");
    expect(pickSample(catalog, "Medieval knights in armor").id).toBe("cesium-man");
    expect(pickSample(catalog, "an enchanted sword with a gold hilt").id).toBe("sword");
    expect(pickSample(catalog, "cozy cottages").id).toBe("house");
    expect(pickSample(catalog, "a delivery truck").id).toBe("milk-truck");
  });

  it("is deterministic for unknown prompts", () => {
    expect(pickSample(catalog, "zzzz qqqq").id).toBe(pickSample(catalog, "zzzz qqqq").id);
  });

  it("hashes identically to Rust", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });

  it("every catalog file exists", () => {
    for (const s of catalog.samples) expect(sampleBytes(s.file).length).toBeGreaterThan(1000);
  });
});

describe("retexture prompts", () => {
  it("maps color and surface words", () => {
    const e = materialEditFromPrompt("red rusty metal");
    expect(e.tint).toEqual([1, 0.22, 0.2]);
    expect(e.metallic).toBe(1);
  });

  it("still recolors unknown words", () => {
    expect(materialEditFromPrompt("zorblax").tint).not.toBeNull();
  });
});

describe("stages", () => {
  it("labels progress", () => {
    expect(stageAt(GENERATE_STAGES, 0.02)).toBe("Reading your prompt");
    expect(stageAt(GENERATE_STAGES, 0.99)).toBe("Downloading model");
  });
});
