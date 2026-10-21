import { toast } from "sonner";
import { errorMessage, getBackend } from "@/lib/backend";
import type { Project } from "@/lib/backend/types";
import { useLibrary } from "@/stores/library";
import { navigate } from "@/stores/route";

function fail(err: unknown): void {
  const { title, description } = errorMessage(err);
  toast.error(title, { description });
}

export async function toggleFavorite(p: Project): Promise<void> {
  const lib = useLibrary.getState();
  lib.patch(p.id, { favorite: !p.favorite });
  try {
    await getBackend().setFavorite(p.id, !p.favorite);
  } catch (err) {
    lib.patch(p.id, { favorite: p.favorite });
    fail(err);
  }
}

export async function renameProject(p: Project, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === p.name) return;
  const lib = useLibrary.getState();
  lib.patch(p.id, { name: trimmed });
  try {
    await getBackend().renameProject(p.id, trimmed);
  } catch (err) {
    lib.patch(p.id, { name: p.name });
    fail(err);
  }
}

export async function setTags(p: Project, tags: string[]): Promise<void> {
  const lib = useLibrary.getState();
  lib.patch(p.id, { tags });
  try {
    await getBackend().setTags(p.id, tags);
  } catch (err) {
    lib.patch(p.id, { tags: p.tags });
    fail(err);
  }
}

export async function duplicateProject(p: Project): Promise<void> {
  const t = toast.loading(`Duplicating “${p.name}”…`);
  try {
    const copy = await getBackend().duplicateProject(p.id);
    await useLibrary.getState().load();
    toast.success(`Created “${copy.name}”`, { id: t });
  } catch (err) {
    toast.dismiss(t);
    fail(err);
  }
}

export async function deleteProject(p: Project): Promise<void> {
  const lib = useLibrary.getState();
  const before = lib.projects;
  lib.drop(p.id);
  try {
    await getBackend().deleteProject(p.id);
    toast.success(`Deleted “${p.name}”`, {
      description: getBackend().kind === "desktop" ? "Moved to the Recycle Bin." : "Removed from this browser.",
    });
  } catch (err) {
    useLibrary.setState({ projects: before });
    fail(err);
  }
}

export async function exportProjectFile(p: Project): Promise<void> {
  try {
    const res = await getBackend().saveProjectFile(p.id);
    if (res) toast.success("Project saved", { description: res.path });
  } catch (err) {
    fail(err);
  }
}

export async function revealProject(p: Project): Promise<void> {
  try {
    await getBackend().reveal({ kind: "project", id: p.id });
  } catch (err) {
    fail(err);
  }
}

export async function openFile(kind: "model" | "project"): Promise<void> {
  try {
    const id = kind === "model" ? await getBackend().importModel("pick") : await getBackend().openProjectFile("pick");
    if (id) {
      await useLibrary.getState().load();
      navigate({ name: "studio", projectId: id });
    }
  } catch (err) {
    fail(err);
  }
}
