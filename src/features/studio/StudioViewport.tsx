import { useMemo } from "react";
import { AlertTriangle, Box, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Progress } from "@/components/ui/misc";
import { Spinner } from "@/components/ui/spinner";
import { ProjectThumb } from "@/features/library/ProjectThumb";
import { cn } from "@/lib/utils";
import { selectedVersion, useStudio } from "@/stores/studio";
import { useViewer } from "@/stores/viewer";
import { availableChannels } from "@/viewer/materials";
import { CompareDivider, StatsOverlay } from "@/viewer/overlays";
import { useModel } from "@/viewer/useModel";
import { useProjectJobs } from "./useProjectJobs";
import { Viewport } from "@/viewer/Viewport";
import { ViewportToolbar } from "@/viewer/ViewportToolbar";

function VariantPicker() {
  const detail = useStudio((s) => s.detail);
  const selectedId = useStudio((s) => s.selectedVersionId);
  const select = useStudio((s) => s.select);
  const current = detail?.versions.find((v) => v.id === selectedId);
  if (!detail || !current?.variantGroup) return null;
  const group = detail.versions.filter((v) => v.variantGroup === current.variantGroup).sort((a, b) => (a.variantIndex ?? 0) - (b.variantIndex ?? 0));
  if (group.length < 2) return null;
  return (
    <div className="surface-floating pointer-events-auto grid grid-cols-2 gap-1 rounded-panel p-1" role="radiogroup" aria-label="Variants">
      {group.map((v, i) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={v.id === selectedId}
          aria-label={`Variant ${i + 1}`}
          onClick={() => select(v.id)}
          className={cn("focus-gradient relative size-14 overflow-hidden rounded-control border transition-soft", v.id === selectedId ? "border-accent-border" : "border-transparent opacity-75 hover:opacity-100")}
        >
          <ProjectThumb versionId={v.hasThumbnail ? v.id : null} cacheKey={v.hasThumbnail ? 1 : 0} alt={`Variant ${i + 1}`} className="size-full" />
          <span className="absolute bottom-0.5 left-1 text-2xs text-fg">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

export function StudioViewport() {
  const s = useStudio();
  const version = selectedVersion(s);
  const compareVersionId = useViewer((v) => v.compareVersionId);
  const focusMode = useViewer((v) => v.focusMode);
  const setViewer = useViewer((v) => v.set);
  const { model, loading, error, retry } = useModel(version?.id ?? null);
  const compare = useModel(compareVersionId && compareVersionId !== version?.id ? compareVersionId : null);
  const jobs = useProjectJobs(s.projectId);
  const genJob = jobs.find((j) => j.kind === "generate") ?? jobs[0] ?? null;
  const generating = genJob && (genJob.kind === "generate" || !model) ? { progress: genJob.progress } : null;
  const channels = useMemo(() => (model ? availableChannels(model.root) : new Set<never>()), [model]);
  const reveal = Boolean(version && s.revealIds.includes(version.id) && !generating);
  const compareVersion = s.detail?.versions.find((v) => v.id === compareVersionId);

  return (
    <Viewport
      className="relative min-h-0 flex-1 overflow-hidden"
      model={model}
      compareModel={compare.model}
      generating={generating}
      reveal={reveal}
      onRevealDone={() => version && s.consumeReveal(version.id)}
      edits={s.edits}
    >
      <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center">
        <ViewportToolbar name={s.detail?.project.name ?? "Shift3D"} availableChannels={channels} disabled={!model} />
      </div>

      {compare.model && model && compareVersion && version && (
        <CompareDivider leftLabel={compareVersion.label} rightLabel={version.label} onExit={() => setViewer({ compareVersionId: null })} />
      )}

      <div className={cn("pointer-events-none absolute bottom-3 left-3", compare.model && "hidden")}>
        <StatsOverlay stats={version?.stats ?? null} />
      </div>

      {!compare.model && (
        <div className={cn("pointer-events-none absolute right-3 top-3", focusMode && "top-14")}>
          <VariantPicker />
        </div>
      )}

      {genJob && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <div className="surface-floating w-[320px] space-y-2 rounded-panel px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-fg">
                <Sparkles className="size-3.5 shrink-0 text-accent" />
                <span className="truncate">{genJob.stage || "Queued"}</span>
              </span>
              <span className="tabular text-xs text-subtle">{Math.round(genJob.progress * 100)}%</span>
            </div>
            <Progress value={genJob.progress} indeterminate={genJob.status === "queued"} label="Generation progress" />
            {jobs.length > 1 && <div className="text-2xs text-subtle">{jobs.length} jobs running for this project</div>}
          </div>
        </div>
      )}

      {!s.projectId && !genJob && (
        <div className="absolute inset-0 flex items-center justify-center">
          <EmptyState icon={<Box />} title="Shift ideas into 3D" description="Describe something on the left, drop in an image, or open a project from your library." />
        </div>
      )}

      {s.projectId && s.detail && !s.detail.versions.length && !genJob && (
        <div className="absolute inset-0 flex items-center justify-center">
          <EmptyState icon={<Box />} title="No versions yet" description="Generate a model to fill this project." />
        </div>
      )}

      {(loading || s.loading) && !model && !genJob && (
        <div className="absolute inset-0 flex items-center justify-center text-muted">
          <Spinner size={20} />
        </div>
      )}

      {(error || s.error) && !genJob && (
        <div className="absolute inset-0 flex items-center justify-center">
          <EmptyState
            icon={<AlertTriangle />}
            title={error?.title ?? s.error ?? "Couldn't load the model"}
            description={error?.description}
            action={
              <Button size="sm" onClick={() => (error ? retry() : void s.open(s.projectId))}>
                Try again
              </Button>
            }
          />
        </div>
      )}
    </Viewport>
  );
}
