import { useState, type ReactNode } from "react";
import { Slider as S } from "radix-ui";
import { cn } from "@/lib/utils";

interface SliderProps {
  label?: ReactNode;
  value: number;
  onChange: (value: number) => void;
  /** Fires once when the user releases the thumb (good for committing undo steps). */
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Slider({
  label,
  value,
  onChange,
  onCommit,
  min = 0,
  max = 1,
  step = 0.01,
  format = (v) => v.toFixed(2),
  disabled,
  className,
  ariaLabel,
}: SliderProps) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className={cn("flex flex-col gap-1.5", disabled && "opacity-50", className)}>
      {label && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{label}</span>
          <span className={cn("tabular text-xs transition-soft", dragging ? "text-fg" : "text-subtle")}>{format(value)}</span>
        </div>
      )}
      <S.Root
        className="group relative flex h-4 w-full touch-none select-none items-center"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(v[0] ?? value)}
        onValueCommit={(v) => onCommit?.(v[0] ?? value)}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
      >
        <S.Track className="relative h-1 grow overflow-hidden rounded-full bg-active">
          <S.Range className="absolute h-full rounded-full bg-accent-gradient" />
        </S.Track>
        <S.Thumb
          aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
          className={cn(
            "block size-3.5 rounded-full border-2 border-fg bg-bg shadow-soft-sm outline-none transition-[transform,box-shadow] duration-150",
            "hover:scale-110 focus-visible:shadow-[0_0_0_4px_var(--accent-soft)] active:scale-110",
          )}
        />
      </S.Root>
    </div>
  );
}
