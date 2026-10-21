import { useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { getBackend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useRoute } from "@/stores/route";
import { redo, undo, useStudio } from "@/stores/studio";
import { RENDER_MODES, useViewer } from "@/stores/viewer";
import { ensureThumbnails } from "@/viewer/thumbnails";
import { CreatePanel } from "./CreatePanel";
import { ModelPanel } from "./ModelPanel";
import { StudioViewport } from "./StudioViewport";
import { useProjectJobs } from "./useProjectJobs";
import { VersionTimeline } from "./VersionTimeline";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

function useStudioShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !isTyping(e) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !isTyping(e) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod || e.altKey || isTyping(e)) return;
      const v = useViewer.getState();
      if (e.key === "Escape") {
        if (v.compareVersionId) v.set({ compareVersionId: null });
        else if (v.focusMode) v.set({ focusMode: false });
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        v.toggle("turntable");
        return;
      }
      const k = e.key.toUpperCase();
      if (k === "R") return v.resetCamera();
      if (k === "F") return v.toggle("focusMode");
      if (k === "G") return v.toggle("showGrid");
      const mode = RENDER_MODES.find((m) => m.shortcut === k);
      if (mode) v.set({ renderMode: mode.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function StudioScreen({ projectId: routeProjectId }: { projectId?: string }) {
  const lastProjectId = useRoute((s) => s.lastProjectId);
  const projectId = routeProjectId ?? lastProjectId ?? null;
  const open = useStudio((s) => s.open);
  const detail = useStudio((s) => s.detail);
  const focusMode = useViewer((s) => s.focusMode);
  const jobs = useProjectJobs(projectId);
  const activeCount = jobs.length;

  const [detailsOpen, setDetailsOpen] = useState(false);

  useStudioShortcuts();

  useEffect(() => {
    void open(projectId);
  }, [open, projectId]);

  // Pick up new versions as the engine writes them.
  useEffect(() => {
    if (!projectId) return;
    return getBackend().onLibraryChanged((e) => {
      if (e.type === "project" && e.projectId === projectId) void useStudio.getState().refresh();
      if (e.type === "deleted" && e.projectId === projectId) void useStudio.getState().open(null);
    });
  }, [projectId]);

  // A job finishing is also a cue to refresh (covers backends that batch library events).
  useEffect(() => {
    if (projectId && activeCount === 0) void useStudio.getState().refresh();
  }, [projectId, activeCount]);

  useEffect(() => {
    if (detail) ensureThumbnails(detail.versions);
  }, [detail]);

  // Leaving the studio exits focus mode and compare.
  useEffect(() => () => useViewer.getState().set({ focusMode: false, compareVersionId: null }), []);

  return (
    <div className="relative flex min-h-0 flex-1">
      <aside className={cn("flex w-[260px] shrink-0 flex-col border-r lg:w-[300px] border-divider bg-panel", focusMode && "hidden")} aria-label="Create">
        <CreatePanel />
      </aside>
      <section className="relative flex min-w-0 flex-1 flex-col">
        {!focusMode && (
          <div className="absolute left-3 top-14 z-10 lg:hidden">
            <IconButton label={detailsOpen ? "Hide model panel" : "Show model panel"} variant="secondary" size="icon-sm" active={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>
              <PanelRight />
            </IconButton>
          </div>
        )}
        <StudioViewport />
        {!focusMode && <VersionTimeline />}
      </section>
      <aside
        className={cn(
          "w-[300px] shrink-0 flex-col border-l border-divider bg-panel lg:static lg:flex lg:shadow-none",
          detailsOpen ? "absolute inset-y-0 right-0 z-20 flex shadow-soft-md" : "hidden",
          focusMode && "!hidden",
        )}
        aria-label="Model"
      >
        <ModelPanel />
      </aside>
    </div>
  );
}
