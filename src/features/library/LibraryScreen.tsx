import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Copy,
  FileBox,
  FolderOpen,
  FolderSearch,
  LibraryBig,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Badge, EmptyState } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { getBackend } from "@/lib/backend";
import type { Project, Style } from "@/lib/backend/types";
import { PROVIDER_LABEL, STYLE_LABEL } from "@/lib/providers";
import { cn, formatBytes, formatRelative } from "@/lib/utils";
import { useLibrary } from "@/stores/library";
import { navigate } from "@/stores/route";
import { ProjectThumb } from "./ProjectThumb";
import { deleteProject, duplicateProject, exportProjectFile, openFile, renameProject, revealProject, setTags, toggleFavorite } from "./actions";

type Sort = "recent" | "oldest" | "name" | "size";
type Dialogs = { kind: "rename" | "tags" | "delete"; project: Project } | null;

function useFiltered(query: string, favorites: boolean, style: Style | "all", tag: string | null, sort: Sort) {
  const projects = useLibrary((s) => s.projects);
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects.filter(
      (p) =>
        (!favorites || p.favorite) &&
        (style === "all" || p.style === style) &&
        (!tag || p.tags.includes(tag)) &&
        (!q || p.name.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q))),
    );
    const sorted = [...list];
    if (sort === "oldest") sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "size") sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    else sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sorted;
  }, [projects, query, favorites, style, tag, sort]);
}

function ProjectMenuItems({ p, onDialog, Item, Sep }: { p: Project; onDialog: (d: Dialogs) => void; Item: typeof DropdownMenuItem; Sep: typeof DropdownMenuSeparator }) {
  const desktop = getBackend().kind === "desktop";
  return (
    <>
      <Item icon={<FolderOpen />} onSelect={() => navigate({ name: "studio", projectId: p.id })}>
        Open in Studio
      </Item>
      <Item icon={<Star />} onSelect={() => void toggleFavorite(p)}>
        {p.favorite ? "Remove from favorites" : "Add to favorites"}
      </Item>
      <Sep />
      <Item icon={<Pencil />} onSelect={() => onDialog({ kind: "rename", project: p })}>
        Rename…
      </Item>
      <Item icon={<Tag />} onSelect={() => onDialog({ kind: "tags", project: p })}>
        Edit tags…
      </Item>
      <Item icon={<Copy />} onSelect={() => void duplicateProject(p)}>
        Duplicate
      </Item>
      <Item icon={<PackageOpen />} onSelect={() => void exportProjectFile(p)}>
        Save as .shift3d…
      </Item>
      <Item icon={<FolderSearch />} disabled={!desktop} disabledReason="Desktop app" onSelect={() => void revealProject(p)}>
        Show in Explorer
      </Item>
      <Sep />
      <Item icon={<Trash2 />} danger onSelect={() => onDialog({ kind: "delete", project: p })}>
        Delete…
      </Item>
    </>
  );
}

function ProjectCard({ p, index, onDialog }: { p: Project; index: number; onDialog: (d: Dialogs) => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          layout
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ delay: Math.min(index, 12) * 0.02, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="group relative overflow-hidden rounded-panel border border-border bg-panel transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-soft-md"
        >
          <button type="button" className="focus-gradient block w-full text-left" onClick={() => navigate({ name: "studio", projectId: p.id })} aria-label={`Open ${p.name}`}>
            <ProjectThumb versionId={p.thumbnailVersionId} cacheKey={p.updatedAt} alt={p.name} className="aspect-[4/3]" />
            <div className="space-y-1.5 border-t border-divider px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{p.name}</span>
                <span className="tabular shrink-0 text-2xs text-subtle">{formatRelative(p.updatedAt)}</span>
              </div>
              <div className="line-clamp-1 h-4 text-xs text-subtle">{p.prompt || "Imported model"}</div>
              <div className="flex flex-wrap items-center gap-1">
                {p.style && <Badge>{STYLE_LABEL[p.style]}</Badge>}
                {p.provider && <Badge>{PROVIDER_LABEL[p.provider]}</Badge>}
                <Badge>
                  {p.versionCount} version{p.versionCount === 1 ? "" : "s"}
                </Badge>
                {p.tags.slice(0, 2).map((t) => (
                  <Badge key={t} tone="accent">
                    #{t}
                  </Badge>
                ))}
              </div>
            </div>
          </button>
          <div className="absolute right-2 top-2 flex gap-1">
            <Tooltip content={p.favorite ? "Remove from favorites" : "Add to favorites"}>
              <button
                type="button"
                aria-label="Favorite"
                aria-pressed={p.favorite}
                onClick={() => void toggleFavorite(p)}
                className={cn(
                  "focus-gradient flex size-7 items-center justify-center rounded-control surface-floating transition-soft",
                  p.favorite ? "text-warning" : "text-muted opacity-0 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <Star className={cn("size-3.5", p.favorite && "fill-current")} />
              </button>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More actions"
                  className="focus-gradient flex size-7 items-center justify-center rounded-control text-muted opacity-0 surface-floating transition-soft hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ProjectMenuItems p={p} onDialog={onDialog} Item={DropdownMenuItem} Sep={DropdownMenuSeparator} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ProjectMenuItems p={p} onDialog={onDialog} Item={ContextMenuItem as typeof DropdownMenuItem} Sep={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const submit = () => {
    void renameProject(project, name);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Rename project" className="w-[420px]">
        <DialogBody>
          <Input
            autoFocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label="Project name"
            onFocus={(e) => e.target.select()}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} disabledReason="Names can't be empty" onClick={submit}>
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TagsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [tags, setLocal] = useState(project.tags);
  const [draft, setDraft] = useState("");
  const all = useLibrary((s) => [...new Set(s.projects.flatMap((p) => p.tags))].sort());
  const add = (t: string) => {
    const clean = t.trim().toLowerCase().replace(/^#/, "").slice(0, 32);
    if (clean && !tags.includes(clean) && tags.length < 20) setLocal([...tags, clean]);
    setDraft("");
  };
  const suggestions = all.filter((t) => !tags.includes(t) && t.includes(draft.toLowerCase())).slice(0, 8);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Edit tags" description="Tags help you filter the library." className="w-[440px]">
        <DialogBody className="space-y-3">
          <div className="flex min-h-8 flex-wrap gap-1.5">
            {tags.length === 0 && <span className="text-sm text-subtle">No tags yet.</span>}
            {tags.map((t) => (
              <span key={t} className="inline-flex h-6 items-center gap-1 rounded-chip border border-accent-border bg-accent-softer pl-2 pr-1 text-xs text-fg">
                #{t}
                <button type="button" aria-label={`Remove ${t}`} onClick={() => setLocal(tags.filter((x) => x !== t))} className="rounded p-0.5 text-subtle hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <Input
            autoFocus
            value={draft}
            placeholder="Type a tag and press Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(draft);
              }
            }}
            aria-label="New tag"
            leading={<Tag />}
          />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <button key={t} type="button" onClick={() => add(t)} className="h-6 rounded-chip border border-border bg-field px-2 text-xs text-muted hover:text-fg">
                  #{t}
                </button>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void setTags(project, draft.trim() ? [...tags, draft.trim().toLowerCase()] : tags);
              onClose();
            }}
          >
            Save tags
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const desktop = getBackend().kind === "desktop";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Delete “${project.name}”?`}
        description={
          desktop
            ? `All ${project.versionCount} version${project.versionCount === 1 ? "" : "s"} (${formatBytes(project.sizeBytes)}) move to the Recycle Bin — you can restore them from there.`
            : `All ${project.versionCount} version${project.versionCount === 1 ? "" : "s"} are removed from this browser.`
        }
        className="w-[440px]"
      >
        <DialogFooter className="border-t-0 pt-0">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 />}
            onClick={() => {
              void deleteProject(project);
              onClose();
            }}
          >
            {desktop ? "Move to Recycle Bin" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LibraryScreen() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "favorites">("all");
  const [style, setStyle] = useState<Style | "all">("all");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [dialog, setDialog] = useState<Dialogs>(null);
  const total = useLibrary((s) => s.projects.length);
  const loaded = useLibrary((s) => s.loaded);
  const allTags = useLibrary((s) => [...new Set(s.projects.flatMap((p) => p.tags))].sort().join("|"));
  const projects = useFiltered(query, view === "favorites", style, tag, sort);
  const filtering = Boolean(query || view === "favorites" || style !== "all" || tag);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-divider px-6 py-4">
        <div className="mr-2">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Library</h1>
          <p className="text-xs text-subtle">
            {total} project{total === 1 ? "" : "s"}
            {getBackend().kind === "desktop" ? " · saved in Documents\\Shift3D" : " · saved in this browser"}
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search names, prompts and tags"
          aria-label="Search the library"
          leading={<Search />}
          trailing={
            query ? (
              <IconButton label="Clear search" size="icon-xs" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            ) : undefined
          }
          className="w-[280px]"
        />
        <Segmented<"all" | "favorites">
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "All" },
            { value: "favorites", label: "Favorites", icon: <Star /> },
          ]}
        />
        <Select<Style | "all">
          ariaLabel="Style filter"
          value={style}
          onChange={setStyle}
          className="w-[140px]"
          options={[{ value: "all", label: "All styles" }, ...(Object.keys(STYLE_LABEL) as Style[]).map((s) => ({ value: s, label: STYLE_LABEL[s] }))]}
        />
        <Select<Sort>
          ariaLabel="Sort"
          value={sort}
          onChange={setSort}
          className="w-[150px]"
          options={[
            { value: "recent", label: "Recently edited" },
            { value: "oldest", label: "Oldest first" },
            { value: "name", label: "Name" },
            { value: "size", label: "Largest" },
          ]}
        />
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button icon={<FolderOpen />}>Open file</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<FileBox />} onSelect={() => void openFile("model")}>
              3D model (.glb, .gltf)…
            </DropdownMenuItem>
            <DropdownMenuItem icon={<PackageOpen />} onSelect={() => void openFile("project")}>
              Shift3D project (.shift3d)…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="primary" icon={<Sparkles />} onClick={() => navigate({ name: "home" })}>
          New model
        </Button>
      </div>

      {allTags && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-6 pt-3 scrollbar-none">
          <Tag className="size-3.5 shrink-0 text-subtle" />
          {allTags.split("|").map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTag(tag === t ? null : t)}
              className={cn(
                "h-6 shrink-0 rounded-chip border px-2 text-xs transition-soft",
                tag === t ? "border-accent-border bg-accent-soft text-fg" : "border-border bg-field text-muted hover:text-fg",
              )}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!loaded ? null : total === 0 ? (
          <EmptyState
            className="h-full"
            icon={<LibraryBig />}
            title="Your library is empty"
            description="Every model you generate or open lands here, with its full version history."
            action={
              <div className="flex gap-2">
                <Button icon={<FolderOpen />} onClick={() => void openFile("model")}>
                  Open a model
                </Button>
                <Button variant="primary" icon={<Sparkles />} onClick={() => navigate({ name: "home" })}>
                  Make something
                </Button>
              </div>
            }
          />
        ) : projects.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Search />}
            title="Nothing matches"
            description={filtering ? "Try a different search or clear the filters." : undefined}
            action={
              <Button
                onClick={() => {
                  setQuery("");
                  setView("all");
                  setStyle("all");
                  setTag(null);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            <AnimatePresence initial={false}>
              {projects.map((p, i) => (
                <ProjectCard key={p.id} p={p} index={i} onDialog={setDialog} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {dialog?.kind === "rename" && <RenameDialog project={dialog.project} onClose={() => setDialog(null)} />}
      {dialog?.kind === "tags" && <TagsDialog project={dialog.project} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && <DeleteDialog project={dialog.project} onClose={() => setDialog(null)} />}
    </div>
  );
}
