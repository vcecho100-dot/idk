import { useState } from "react";
import {
  Camera,
  ChevronDown,
  Circle,
  Compass,
  Crosshair,
  Gauge,
  Grid2x2,
  Grid3x3,
  Hash,
  Image,
  Layers,
  Maximize,
  Minimize,
  Palette,
  RotateCw,
  Sun,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { getBackend } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { BACKGROUNDS, LIGHTING_PRESETS, MAP_CHANNELS, RENDER_MODES, useViewer, type MapChannel, type RenderMode } from "@/stores/viewer";
import { takeScreenshot } from "./capture";

const MODE_ICON: Record<RenderMode, typeof Palette> = {
  textured: Palette,
  clay: Circle,
  wireframe: Grid3x3,
  normals: Compass,
  uv: Grid2x2,
  maps: Layers,
};

function Divider() {
  return <div className="mx-0.5 h-5 w-px bg-divider" />;
}

export function ViewportToolbar({ name, availableChannels, disabled }: { name: string; availableChannels: Set<MapChannel>; disabled: boolean }) {
  const s = useViewer();
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = async () => {
    const next = !s.focusMode;
    s.set({ focusMode: next });
    setFullscreen(next);
    try {
      if (getBackend().kind === "desktop") {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(next);
      } else if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* fullscreen not permitted; focus mode still hides the panels */
    }
  };

  return (
    <div className="surface-floating pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-panel p-1 [scrollbar-width:none]" role="toolbar" aria-label="Viewport">
      {RENDER_MODES.map((m) => {
        const Icon = MODE_ICON[m.id];
        return (
          <IconButton key={m.id} label={m.label} shortcut={m.shortcut} size="icon-sm" active={s.renderMode === m.id} disabled={disabled} onClick={() => s.set({ renderMode: m.id })}>
            <Icon />
          </IconButton>
        );
      })}
      {s.renderMode === "maps" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="focus-gradient ml-0.5 flex h-7 items-center gap-1 rounded-control bg-field px-2 text-xs text-fg">
              {MAP_CHANNELS.find((c) => c.id === s.mapChannel)?.label}
              <ChevronDown className="size-3 text-subtle" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuLabel>Texture map</DropdownMenuLabel>
            {MAP_CHANNELS.map((c) => (
              <DropdownMenuCheckboxItem key={c.id} checked={s.mapChannel === c.id} onCheckedChange={() => s.set({ mapChannel: c.id })}>
                <span className="flex-1">{c.label}</span>
                {!availableChannels.has(c.id) && <span className="text-2xs text-subtle">factor only</span>}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Divider />
      <DropdownMenu>
        <Tooltip content="Lighting">
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Lighting" className="focus-gradient flex h-7 items-center gap-1 rounded-control px-2 text-muted transition-soft hover:bg-hover hover:text-fg">
              <Sun className="size-4" />
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="center">
          <DropdownMenuLabel>Lighting</DropdownMenuLabel>
          {LIGHTING_PRESETS.map((l) => (
            <DropdownMenuCheckboxItem key={l.id} checked={s.lighting === l.id} onCheckedChange={() => s.set({ lighting: l.id })}>
              {l.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <Tooltip content="Background">
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Background" className="focus-gradient flex h-7 items-center gap-1 rounded-control px-2 text-muted transition-soft hover:bg-hover hover:text-fg">
              <Image className="size-4" />
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="center">
          <DropdownMenuLabel>Background</DropdownMenuLabel>
          {BACKGROUNDS.map((b) => (
            <DropdownMenuCheckboxItem key={b.id} checked={s.background === b.id} onCheckedChange={() => s.set({ background: b.id })}>
              {b.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton label="Grid" size="icon-sm" active={s.showGrid} onClick={() => s.toggle("showGrid")}>
        <Hash />
      </IconButton>
      <Divider />
      <IconButton label="Turntable" shortcut="Space" size="icon-sm" active={s.turntable} disabled={disabled} onClick={() => s.toggle("turntable")}>
        <RotateCw className={cn(s.turntable && "animate-spin-slow")} />
      </IconButton>
      <IconButton label="Screenshot" size="icon-sm" disabled={disabled} disabledReason="Nothing to capture yet" onClick={() => void takeScreenshot(name)}>
        <Camera />
      </IconButton>
      <IconButton label="Reset camera" shortcut="R" size="icon-sm" onClick={() => s.resetCamera()}>
        <Crosshair />
      </IconButton>
      <IconButton label="Stats" size="icon-sm" active={s.showStats} onClick={() => s.toggle("showStats")}>
        <Gauge />
      </IconButton>
      <IconButton label={fullscreen ? "Exit focus mode" : "Focus mode"} shortcut="F" size="icon-sm" onClick={() => void toggleFullscreen()}>
        {fullscreen ? <Minimize /> : <Maximize />}
      </IconButton>
    </div>
  );
}
