import { useEffect, useRef, useState } from "react";
import { Box, House, LibraryBig, Search, Settings } from "lucide-react";
import { toast } from "sonner";
import { LogoMark, Wordmark } from "@/brand/Logo";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { errorMessage, getBackend } from "@/lib/backend";
import { IS_DESKTOP } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useLibrary } from "@/stores/library";
import { navigate, useRoute, type RouteName } from "@/stores/route";
import { useUi } from "@/stores/ui";
import { JobsIndicator } from "./JobsIndicator";
import { WindowControls } from "./WindowControls";

function ProjectTitle({ projectId }: { projectId: string }) {
  const project = useLibrary((s) => s.projects.find((p) => p.id === projectId));
  const patch = useLibrary((s) => s.patch);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!project) return null;

  const commit = async () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === project.name) return;
    const prev = project.name;
    patch(project.id, { name });
    try {
      await getBackend().renameProject(project.id, name);
    } catch (err) {
      patch(project.id, { name: prev });
      const { title, description } = errorMessage(err);
      toast.error(title, { description });
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Project name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
        maxLength={120}
        className="h-7 w-[260px] rounded-control border border-accent-border bg-field px-2 text-center text-sm font-medium text-fg outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      title="Double-click to rename"
      onDoubleClick={() => {
        setDraft(project.name);
        setEditing(true);
      }}
      className="max-w-[320px] truncate rounded-control px-2 py-1 text-sm font-medium text-fg transition-soft hover:bg-hover"
    >
      {project.name}
    </button>
  );
}

export function TitleBar() {
  const route = useRoute((s) => s.route);
  const lastProjectId = useRoute((s) => s.lastProjectId);
  const setPalette = useUi((s) => s.setPalette);
  const drag = IS_DESKTOP ? { "data-tauri-drag-region": true } : {};

  const go = (name: RouteName) => {
    if (name === "studio") navigate({ name: "studio", projectId: lastProjectId ?? undefined });
    else navigate({ name });
  };

  return (
    <header
      {...drag}
      className="relative z-40 flex h-[var(--titlebar-h)] shrink-0 select-none items-center border-b border-divider bg-shell pl-3"
    >
      <button
        type="button"
        onClick={() => navigate({ name: "home" })}
        className="focus-gradient flex items-center gap-2 rounded-control py-1 pl-1 pr-2 text-md transition-soft hover:bg-hover"
        aria-label="Shift3D home"
      >
        <LogoMark size={18} />
        <Wordmark className="text-base" />
      </button>

      <div className="ml-3">
        <Segmented<RouteName>
          label="Navigation"
          size="sm"
          value={route.name === "settings" ? ("" as RouteName) : route.name}
          onChange={go}
          options={[
            { value: "home", label: "Home", icon: <House /> },
            { value: "studio", label: "Studio", icon: <Box /> },
            { value: "library", label: "Library", icon: <LibraryBig /> },
          ]}
        />
      </div>

      <div {...drag} className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center">
        {route.name === "studio" && route.projectId && <ProjectTitle projectId={route.projectId} />}
      </div>

      <div {...drag} className="h-full flex-1" />

      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={() => setPalette(true)}
          className={cn(
            "focus-gradient mr-1 hidden h-7 w-[220px] items-center gap-2 rounded-control border border-border bg-field px-2 text-sm text-subtle transition-soft lg:flex",
            "hover:border-border-strong hover:text-muted",
          )}
        >
          <Search className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">Search or run a command</span>
          <Kbd keys="Ctrl+K" />
        </button>
        <IconButton label="Command palette" shortcut="Ctrl+K" size="icon-sm" className="lg:hidden" onClick={() => setPalette(true)}>
          <Search />
        </IconButton>
        <JobsIndicator />
        <IconButton
          label="Settings"
          size="icon-sm"
          active={route.name === "settings"}
          onClick={() => navigate({ name: "settings", section: "general" })}
        >
          <Settings />
        </IconButton>
      </div>

      {IS_DESKTOP && (
        <>
          <div className="mx-1 h-4 w-px bg-divider" />
          <WindowControls />
        </>
      )}
    </header>
  );
}
