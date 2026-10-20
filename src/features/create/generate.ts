import { toast } from "sonner";
import { errorMessage, getBackend } from "@/lib/backend";
import type { GenerateRequest } from "@/lib/backend/types";
import { useCreate } from "@/stores/create";
import { useJobs } from "@/stores/jobs";
import { navigate } from "@/stores/route";
import { useSettings } from "@/stores/settings";

export function buildRequest(opts: { projectId?: string; parentVersionId?: string } = {}): GenerateRequest {
  const c = useCreate.getState();
  const provider = c.provider ?? useSettings.getState().settings.defaultProvider;
  const images =
    c.mode === "image" && c.image
      ? [{ imageId: c.image.id, view: null }]
      : c.mode === "multiview"
        ? (["front", "side", "back"] as const).flatMap((v) => (c.views[v] ? [{ imageId: c.views[v]!.id, view: v }] : []))
        : [];
  return {
    projectId: opts.projectId,
    parentVersionId: opts.parentVersionId,
    mode: c.mode,
    prompt: c.prompt.trim(),
    negativePrompt: c.negativePrompt.trim() || undefined,
    images,
    style: c.style,
    quality: c.quality,
    faceLimit: c.faceLimit ?? undefined,
    pbr: c.pbr,
    seed: c.seed ?? undefined,
    variants: c.variants,
    provider,
  };
}

/** Returns a reason the current draft can't be generated yet, or null. */
export function generateBlocker(): string | null {
  const c = useCreate.getState();
  if (c.mode === "text" && !c.prompt.trim()) return "Describe what you want to make";
  if (c.mode === "image" && !c.image) return "Add an image first";
  if (c.mode === "multiview" && !c.views.front) return "Add at least a front view";
  return null;
}

export async function submitGenerate(opts: { projectId?: string; parentVersionId?: string } = {}): Promise<string | null> {
  const c = useCreate.getState();
  if (c.submitting) return null;
  const blocker = generateBlocker();
  if (blocker) {
    toast.message(blocker);
    return null;
  }
  c.set({ submitting: true });
  try {
    const req = buildRequest(opts);
    const res = await getBackend().generate(req);
    // Pull the queued jobs right away so the studio can start "The Shift" without waiting for an event.
    void useJobs.getState().load();
    navigate({ name: "studio", projectId: res.projectId });
    return res.projectId;
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
    return null;
  } finally {
    useCreate.getState().set({ submitting: false });
  }
}
