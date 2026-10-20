import { cn } from "@/lib/utils";
import { formatKeys } from "@/lib/keys";

interface KbdProps {
  keys: string;
  className?: string;
  tone?: "default" | "inverse";
}

/** Renders a shortcut like "Ctrl+Shift+K" as individual key caps. */
export function Kbd({ keys, className, tone = "default" }: KbdProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={keys}>
      {formatKeys(keys).map((k, i) => (
        <kbd
          key={i}
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 font-sans text-2xs font-medium",
            tone === "default" && "border border-border bg-field text-muted",
            tone === "inverse" && "bg-active text-muted",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
