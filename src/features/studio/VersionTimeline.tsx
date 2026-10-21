import { Columns2, GitBranch, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { Progress } from "@/components/ui/misc";
import { ProjectThumb } from "@/features/library/ProjectThumb";
import { errorMessage, getBackend } from "@/lib/backend";
import type { Version } from "@/lib/backend/types";
import { cn, formatRelative } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { useViewer } from "@/stores/viewer";
import { useProjectJobs } from "./useProjectJobs";

async function removeVersion(v: Version, count: number): Promise<void> {
  if (count <= 1) {
    toast.message("A project needs at least one version", { description: "Delete the whole project from the Library instead." });
    return;
  }
  try {
    await getBackend().deleteVersion(v.id);
    if (useViewer.getState().compareVersionId === v.id) useViewer.getState().set({ compareVersionId: null });
    await useStudio.getState().refresh();
    toast.success(`Deleted “${v.label}”`);
  } catch (err) {
    const { title, description } = errorMessage(err);
    toast.error(title, { description });
  }
}

export function VersionTimeline() {
  const detail = useStudio((s) => s.detail);
  const selectedId = useStudio((s) => s.selectedVersionId);
  const select = useStudio((s) => s.select);
  const compareId = useViewer((s) => s.compareVersionId);
  const setViewer = useViewer((s) => s.set);
  const jobs = useProjectJobs(detail?.project.id ?? null);
  if (!detail || (!detail.versions.length && !jobs.length)) return null;
  const versions = detail.versions;

  return (
    <div className="flex h-[104px] shrink-0 items-center gap-2 overflow-x-auto border-t border-divider bg-panel px-3" role="listbox" aria-label="Versions" aria-orientation="horizontal">
      {versions.map((v, i) => {
        const selected = v.id === selectedId;
        const parentIdx = v.parentId ? versions.findIndex((x) => x.id === v.parentId) : -1;
        return (
          <ContextMenu key={v.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => select(v.id)}
                title={`${v.label} · ${formatRelative(v.createdAt)}`}
                className={cn(
                  "focus-gradient group relative flex h-[84px] w-[92px] shrink-0 flex-col overflow-hidden rounded-control border text-left transition-soft",
                  selected ? "border-accent-border bg-accent-softer" : "border-border bg-raised hover:border-border-strong",
                  compareId === v.id && "ring-1 ring-accent",
                )}
              >
                <ProjectThumb versionId={v.hasThumbnail ? v.id : null} cacheKey={v.hasThumbnail ? 1 : 0} alt={v.label} className="h-[58px] w-full" />
                <span className="flex items-center gap-1 px-1.5 pt-1 text-2xs text-fg">
                  <span className="tabular text-subtle">v{i + 1}</span>
                  <span className="truncate">{v.label}</span>
                </span>
                {parentIdx >= 0 && parentIdx !== i - 1 && (
                  <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-overlay px-1 text-2xs text-fg" title={`Branched from v${parentIdx + 1}`}>
                    <GitBranch className="size-2.5" />v{parentIdx + 1}
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                icon={<Columns2 />}
                disabled={selected}
                disabledReason="Shown now"
                onSelect={() => setViewer({ compareVersionId: compareId === v.id ? null : v.id })}
              >
                {compareId === v.id ? "Stop comparing" : "Compare with current"}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem icon={<Trash2 />} danger onSelect={() => void removeVersion(v, versions.length)}>
                Delete version
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {jobs.map((j) => (
        <div key={j.id} className="flex h-[84px] w-[92px] shrink-0 flex-col justify-end gap-1.5 rounded-control border border-dashed border-accent-border bg-accent-softer p-1.5">
          <span className="truncate text-2xs text-fg">{j.title}</span>
          <Progress value={j.progress} indeterminate={j.status === "queued"} label={j.title} />
        </div>
      ))}
      {versions.length > 1 && !compareId && <span className="ml-2 shrink-0 text-2xs text-subtle">Right-click a version to compare</span>}
    </div>
  );
}
