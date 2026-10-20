import { createContext, useContext, useId, type ReactNode } from "react";
import { Tabs as T } from "radix-ui";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

interface TabsCtx {
  value: string;
  layoutId: string;
  variant: "pill" | "underline";
}
const Ctx = createContext<TabsCtx | null>(null);

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  variant?: "pill" | "underline";
}

export function Tabs({ value, onValueChange, children, className, variant = "pill" }: TabsProps) {
  const layoutId = useId();
  return (
    <Ctx.Provider value={{ value, layoutId, variant }}>
      <T.Root value={value} onValueChange={onValueChange} className={cn("flex min-h-0 flex-col", className)}>
        {children}
      </T.Root>
    </Ctx.Provider>
  );
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const ctx = useContext(Ctx);
  return (
    <T.List
      className={cn(
        "relative flex shrink-0 items-center",
        ctx?.variant === "pill" && "gap-0.5 rounded-control bg-field p-0.5",
        ctx?.variant === "underline" && "gap-4 border-b border-divider",
        className,
      )}
    >
      {children}
    </T.List>
  );
}

export function TabsTrigger({
  value,
  children,
  icon,
  className,
  disabled,
}: {
  value: string;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const ctx = useContext(Ctx);
  const active = ctx?.value === value;
  const pill = ctx?.variant !== "underline";
  return (
    <T.Trigger
      value={value}
      disabled={disabled}
      className={cn(
        "focus-gradient relative flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-soft",
        "[&_svg]:size-3.5 disabled:text-disabled",
        pill && "h-7 flex-1 rounded-[6px] px-2.5 text-sm",
        !pill && "h-9 px-0.5 text-sm",
        active ? "text-fg" : "text-subtle hover:text-muted",
        className,
      )}
    >
      {active && ctx && (
        <motion.span
          layoutId={ctx.layoutId}
          transition={{ type: "spring", stiffness: 520, damping: 40 }}
          className={cn(
            "absolute",
            pill && "inset-0 rounded-[6px] border border-border bg-raised shadow-soft-sm",
            !pill && "inset-x-0 -bottom-px h-0.5 rounded-full bg-accent-gradient",
          )}
        />
      )}
      <span className="relative z-[1] flex items-center gap-1.5">
        {icon}
        {children}
      </span>
    </T.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <T.Content value={value} className={cn("min-h-0 flex-1 outline-none", className)}>
      {children}
    </T.Content>
  );
}
