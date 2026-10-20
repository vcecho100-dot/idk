import type { ReactElement, ReactNode } from "react";
import { Tooltip as T } from "radix-ui";
import { Kbd } from "./kbd";
import { cn } from "@/lib/utils";

export const TooltipProvider = T.Provider;

interface TooltipProps {
  content?: ReactNode;
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  children: ReactElement;
  className?: string;
  /** Show even when the trigger is disabled (wrap disabled controls in a span). */
  delay?: number;
}

export function Tooltip({ content, shortcut, side = "top", align = "center", children, className, delay }: TooltipProps) {
  if (!content && !shortcut) return children;
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "anim-pop surface-floating z-[70] flex max-w-[280px] items-center gap-2 rounded-control px-2 py-1.5 text-xs text-fg",
            className,
          )}
        >
          <span className="leading-4">{content}</span>
          {shortcut && <Kbd keys={shortcut} tone="inverse" />}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
