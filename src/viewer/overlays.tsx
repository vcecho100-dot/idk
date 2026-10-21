import { useRef } from "react";
import { MoveHorizontal, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { ModelStats } from "@/lib/backend/types";
import { clamp, cn, formatBytes, formatCount } from "@/lib/utils";
import { useViewer } from "@/stores/viewer";

export function StatsOverlay({ stats, className }: { stats: ModelStats | null; className?: string }) {
  const show = useViewer((s) => s.showStats);
  if (!show || !stats) return null;
  const rows: [string, string][] = [
    ["Triangles", formatCount(stats.triangles)],
    ["Vertices", formatCount(stats.vertices)],
    ["Materials", String(stats.materials)],
    ["Textures", stats.textures ? `${stats.textures} · ${stats.maxTextureSize ? `${stats.maxTextureSize}px` : "—"}` : "none"],
    ["File size", formatBytes(stats.fileSize)],
  ];
  if (stats.animations.length) rows.push(["Animations", String(stats.animations.length)]);
  return (
    <dl className={cn("surface-floating pointer-events-auto grid grid-cols-[auto_auto] gap-x-4 gap-y-1 rounded-panel px-3 py-2.5 text-xs", className)}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="tabular text-right text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The draggable before/after divider for compare mode. */
export function CompareDivider({ leftLabel, rightLabel, onExit }: { leftLabel: string; rightLabel: string; onExit: () => void }) {
  const split = useViewer((s) => s.split);
  const set = useViewer((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);

  const move = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) set({ split: clamp((clientX - r.left) / r.width, 0.04, 0.96) });
  };

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <div className="absolute inset-y-0 w-px bg-fg/80" style={{ left: `${split * 100}%` }}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Compare divider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split * 100)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") set({ split: clamp(split - 0.02, 0.04, 0.96) });
            if (e.key === "ArrowRight") set({ split: clamp(split + 0.02, 0.04, 0.96) });
          }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            move(e.clientX);
          }}
          onPointerMove={(e) => e.buttons && move(e.clientX)}
          className="focus-gradient pointer-events-auto absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-border-strong bg-raised text-fg shadow-soft-md [--focus-radius:999px]"
        >
          <MoveHorizontal className="size-4" />
        </div>
      </div>
      <div className="surface-floating absolute bottom-3 left-3 rounded-control px-2 py-1 text-xs text-fg">{leftLabel}</div>
      <div className="surface-floating absolute bottom-3 right-3 rounded-control px-2 py-1 text-xs text-fg">{rightLabel}</div>
      <div className="pointer-events-auto absolute right-3 top-3">
        <IconButton label="Exit compare" shortcut="Esc" variant="secondary" size="icon-sm" onClick={onExit}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
