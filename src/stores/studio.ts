import { create } from "zustand";
import { temporal } from "zundo";
import { toast } from "sonner";
import { errorMessage, getBackend } from "@/lib/backend";
import type { ProjectDetail, Version } from "@/lib/backend/types";

/** Live, non-destructive material adjustments (baked into a version on Save). */
export interface MaterialEdits {
  tint: string;
  tintAmount: number;
  roughness: number | null;
  metalness: number | null;
  emissive: number;
}

export const NO_EDITS: MaterialEdits = { tint: "#ffffff", tintAmount: 0, roughness: null, metalness: null, emissive: 0 };

export function hasEdits(e: MaterialEdits): boolean {
  return e.tintAmount > 0 || e.roughness !== null || e.metalness !== null || e.emissive > 0;
}

interface StudioState {
  projectId: string | null;
  detail: ProjectDetail | null;
  loading: boolean;
  error: string | null;
  selectedVersionId: string | null;
  edits: MaterialEdits;
  /** Versions created this session that should play "The Shift" reveal when shown. */
  revealIds: string[];
  open(projectId: string | null): Promise<void>;
  refresh(): Promise<void>;
  select(versionId: string): void;
  setEdits(patch: Partial<MaterialEdits>): void;
  resetEdits(): void;
  markReveal(versionId: string): void;
  consumeReveal(versionId: string): void;
}

export const useStudio = create<StudioState>()(
  temporal(
    (set, get) => ({
      projectId: null,
      detail: null,
      loading: false,
      error: null,
      selectedVersionId: null,
      edits: NO_EDITS,
      revealIds: [],

      async open(projectId) {
        if (!projectId) {
          set({ projectId: null, detail: null, selectedVersionId: null, error: null, loading: false, edits: NO_EDITS });
          useStudio.temporal.getState().clear();
          return;
        }
        if (get().projectId !== projectId) {
          set({ projectId, detail: null, loading: true, error: null, selectedVersionId: null, edits: NO_EDITS });
          useStudio.temporal.getState().clear();
        }
        try {
          const detail = await getBackend().getProject(projectId);
          if (get().projectId !== projectId) return;
          useStudio.temporal.getState().pause();
          set({ detail, loading: false, selectedVersionId: get().selectedVersionId ?? detail.project.currentVersionId ?? detail.versions.at(-1)?.id ?? null });
          useStudio.temporal.getState().resume();
        } catch (err) {
          if (get().projectId === projectId) set({ loading: false, error: errorMessage(err).title });
        }
      },

      async refresh() {
        const id = get().projectId;
        if (!id) return;
        try {
          const detail = await getBackend().getProject(id);
          if (get().projectId !== id) return;
          const prevCurrent = get().detail?.project.currentVersionId;
          const known = new Set(get().detail?.versions.map((v) => v.id));
          const fresh = detail.versions.filter((v) => !known.has(v.id));
          useStudio.temporal.getState().pause();
          // Follow the newest result automatically when the engine moved the current version.
          const follow = detail.project.currentVersionId !== prevCurrent || !get().selectedVersionId;
          set({
            detail,
            selectedVersionId: follow ? detail.project.currentVersionId ?? get().selectedVersionId : get().selectedVersionId,
            revealIds: [...get().revealIds, ...fresh.filter((v) => v.kind !== "import").map((v) => v.id)],
          });
          useStudio.temporal.getState().resume();
        } catch {
          /* transient; the next event refreshes again */
        }
      },

      select(versionId) {
        const d = get().detail;
        if (!d || versionId === get().selectedVersionId) return;
        set({ selectedVersionId: versionId, edits: NO_EDITS });
        void getBackend()
          .setCurrentVersion(d.project.id, versionId)
          .catch((err: unknown) => {
            const { title, description } = errorMessage(err);
            toast.error(title, { description });
          });
      },

      setEdits(patch) {
        set({ edits: { ...get().edits, ...patch } });
      },
      resetEdits() {
        set({ edits: NO_EDITS });
      },
      markReveal(id) {
        set({ revealIds: [...get().revealIds, id] });
      },
      consumeReveal(id) {
        set({ revealIds: get().revealIds.filter((r) => r !== id) });
      },
    }),
    {
      // Undo/redo covers what the user changes: which version is shown and material edits.
      partialize: (s) => ({ selectedVersionId: s.selectedVersionId, edits: s.edits }),
      equality: (a, b) => a.selectedVersionId === b.selectedVersionId && JSON.stringify(a.edits) === JSON.stringify(b.edits),
      limit: 100,
    },
  ),
);

export function selectedVersion(s: { detail: ProjectDetail | null; selectedVersionId: string | null }): Version | null {
  return s.detail?.versions.find((v) => v.id === s.selectedVersionId) ?? null;
}

export function undo(): void {
  useStudio.temporal.getState().undo();
  syncCurrent();
}

export function redo(): void {
  useStudio.temporal.getState().redo();
  syncCurrent();
}

/** After undo/redo of a version switch, keep the engine's "current version" in step. */
function syncCurrent(): void {
  const s = useStudio.getState();
  if (s.detail && s.selectedVersionId && s.detail.project.currentVersionId !== s.selectedVersionId) {
    void getBackend().setCurrentVersion(s.detail.project.id, s.selectedVersionId).catch(() => {});
  }
}
