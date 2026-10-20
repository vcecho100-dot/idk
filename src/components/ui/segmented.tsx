import { useId, type ReactNode } from "react";
import { ToggleGroup } from "radix-ui";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  tooltip?: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  className?: string;
  size?: "sm" | "md";
  label: string;
}

export function Segmented<T extends string>({ value, onChange, options, className, size = "md", label }: SegmentedProps<T>) {
  const layoutId = useId();
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(v) => v && onChange(v as T)}
      className={cn("relative flex items-center gap-0.5 rounded-control bg-field p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const item = (
          <ToggleGroup.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            aria-label={typeof opt.label === "string" ? opt.label : opt.tooltip}
            className={cn(
              "focus-gradient relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-soft",
              "[&_svg]:size-3.5 disabled:text-disabled",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
              active ? "text-fg" : "text-subtle hover:text-muted",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
                className="absolute inset-0 rounded-[6px] border border-border bg-raised shadow-soft-sm"
              />
            )}
            <span className="relative z-[1] flex items-center gap-1.5">
              {opt.icon}
              {opt.label}
            </span>
          </ToggleGroup.Item>
        );
        return opt.tooltip ? (
          <Tooltip key={opt.value} content={opt.tooltip}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup.Root>
  );
}
