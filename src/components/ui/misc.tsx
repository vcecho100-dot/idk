import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/* ----------------------------------- Badge ----------------------------------- */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const toneClass: Record<Tone, string> = {
  neutral: "bg-field text-muted border-border",
  accent: "bg-accent-softer text-fg border-accent-border",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
};

export function Badge({ children, tone = "neutral", className, icon }: { children: ReactNode; tone?: Tone; className?: string; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-chip border px-1.5 text-2xs font-medium [&_svg]:size-3",
        toneClass[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/* ---------------------------------- Skeleton ---------------------------------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-control bg-skeleton", className)} aria-hidden>
      <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,var(--skeleton-shine),transparent)]" />
    </div>
  );
}

/* ---------------------------------- Progress ---------------------------------- */

export function Progress({
  value,
  className,
  indeterminate,
  label,
}: {
  value: number;
  className?: string;
  indeterminate?: boolean;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-active", className)}
    >
      {indeterminate ? (
        <div className="absolute inset-y-0 left-0 w-full origin-left animate-indeterminate rounded-full bg-accent-gradient" />
      ) : (
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full bg-accent-gradient"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 140, damping: 26 }}
        />
      )}
    </div>
  );
}

/* --------------------------------- Separator --------------------------------- */

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn("shrink-0 bg-divider", vertical ? "h-4 w-px" : "h-px w-full", className)}
    />
  );
}

/* --------------------------------- Empty state -------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      <div className="relative flex size-12 items-center justify-center rounded-panel border border-border bg-raised text-muted shadow-inset [&_svg]:size-5">
        <div className="absolute inset-0 -z-10 rounded-panel bg-accent-soft blur-xl" />
        {icon}
      </div>
      <div className="space-y-1">
        <div className="text-md font-medium text-fg">{title}</div>
        {description && <div className="mx-auto max-w-[320px] text-sm text-muted">{description}</div>}
      </div>
      {action}
    </div>
  );
}

/* ---------------------------------- Section ---------------------------------- */

export function SectionLabel({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-6 items-center justify-between", className)}>
      <span className="text-2xs font-medium uppercase tracking-[0.08em] text-subtle">{children}</span>
      {action}
    </div>
  );
}
