import { describe, expect, it } from "vitest";
import { clamp, formatBytes, formatCount, nameFromPrompt } from "./utils";
import { enhancePrompt } from "./prompt";
import { formatKeys } from "./keys";

describe("formatting", () => {
  it("formats bytes and counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_400)).toBe("12k");
    expect(formatCount(2_500_000)).toBe("2.50M");
  });

  it("clamps", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
  });

  it("formats shortcuts", () => {
    expect(formatKeys("Ctrl+Enter")).toEqual(["Ctrl", "↵"]);
    expect(formatKeys("k")).toEqual(["K"]);
  });
});

describe("prompts", () => {
  it("names projects like the Rust engine", () => {
    expect(nameFromPrompt("a cute robot dog")).toBe("Cute Robot Dog");
    expect(nameFromPrompt("The sword of fire and ice")).toBe("Sword");
    expect(nameFromPrompt("A fox sitting on its hind legs")).toBe("Fox Sitting");
    expect(nameFromPrompt("", "Untitled")).toBe("Untitled");
  });

  it("enhances prompts with style and production constraints", () => {
    const out = enhancePrompt("a knight", "lowpoly");
    expect(out).toMatch(/^A knight/);
    expect(out).toContain("low-poly");
    expect(out).toContain("game-ready");
    expect(enhancePrompt(out, "lowpoly")).toBe(out);
  });
});
