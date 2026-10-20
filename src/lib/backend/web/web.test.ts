import { describe, expect, it } from "vitest";
import { createWebBackend } from "./index";
import { memoryKV } from "./store";
import type { Backend } from "../api";
import type { GenerateRequest, Job } from "../types";
import { sampleBytes } from "@/test/fixtures";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

async function engine(): Promise<Backend> {
  return createWebBackend({ kv: memoryKV(), storage: memoryStorage(), timeScale: 0.002, loadSample: async (f) => sampleBytes(f) });
}

function waitFor(b: Backend, id: string): Promise<Job> {
  return new Promise((resolve) => {
    const off = b.onJobUpdate((j) => {
      if (j.id === id && ["succeeded", "failed", "canceled"].includes(j.status)) {
        off();
        resolve(j);
      }
    });
  });
}

const base: GenerateRequest = { mode: "text", prompt: "a curious fox", images: [], style: "stylized", quality: "draft", pbr: true, variants: 1, provider: "mock" };

describe("web engine (offline mock mode)", () => {
  it("generates, then refines a draft into a new version", async () => {
    const b = await engine();
    const { projectId, jobIds } = await b.generate(base);
    const job = await waitFor(b, jobIds[0]!);
    expect(job.status).toBe("succeeded");
    const detail = await b.getProject(projectId);
    expect(detail.project.name).toBe("Curious Fox");
    expect(detail.versions).toHaveLength(1);
    const draft = detail.versions[0]!;
    expect(draft.label).toBe("Draft");
    expect(draft.stats?.animations).toContain("Walk");

    const refineId = await b.refine({ projectId, versionId: draft.id, provider: "mock" });
    expect((await waitFor(b, refineId)).status).toBe("succeeded");
    const after = await b.getProject(projectId);
    expect(after.versions).toHaveLength(2);
    expect(after.versions[1]!.parentId).toBe(draft.id);
    expect(after.project.currentVersionId).toBe(after.versions[1]!.id);
  });

  it("creates 4 tinted variants in one project", async () => {
    const b = await engine();
    const { projectId, jobIds } = await b.generate({ ...base, prompt: "a crystal", variants: 4, quality: "standard" });
    expect(jobIds).toHaveLength(4);
    await Promise.all(jobIds.map((id) => waitFor(b, id)));
    const { versions } = await b.getProject(projectId);
    expect(versions.map((v) => v.variantIndex).sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(versions.map((v) => v.variantGroup)).size).toBe(1);
  });

  it("explains why rigging a non-character fails", async () => {
    const b = await engine();
    const { projectId, jobIds } = await b.generate({ ...base, prompt: "a traffic cone" });
    await waitFor(b, jobIds[0]!);
    const { versions } = await b.getProject(projectId);
    const rigId = await b.rig({ projectId, versionId: versions[0]!.id, provider: "mock", animation: "walk" });
    const rig = await waitFor(b, rigId);
    expect(rig.status).toBe("failed");
    expect(rig.error?.hint).toMatch(/knight|fox/);
  });

  it("validates input and rejects cloud providers in the browser", async () => {
    const b = await engine();
    await expect(b.generate({ ...base, prompt: "  " })).rejects.toThrow(/Describe/);
    await expect(b.generate({ ...base, provider: "tripo" })).rejects.toThrow(/desktop app/);
  });

  it("cancels and retries jobs", async () => {
    const b = await createWebBackend({ kv: memoryKV(), storage: memoryStorage(), timeScale: 1, loadSample: async (f) => sampleBytes(f) });
    const { jobIds } = await b.generate(base);
    await b.cancelJob(jobIds[0]!);
    expect((await b.listJobs())[0]!.status).toBe("canceled");
    await b.retryJob(jobIds[0]!);
    expect(["queued", "running"]).toContain((await b.listJobs())[0]!.status);
    await b.cancelJob(jobIds[0]!);
  });

  it("persists settings with validation", async () => {
    const b = await engine();
    const s = await b.updateSettings({ theme: "light", accent: "sunset" });
    expect(s.theme).toBe("light");
    await expect(b.updateSettings({ theme: "neon" as never })).rejects.toThrow();
  });
});
