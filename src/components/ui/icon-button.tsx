import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "tooltip"> {
  label: string;
  children: ReactNode;
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

/** A square icon button whose label doubles as its tooltip and accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, active, size = "icon", variant = "ghost", className, shortcut, disabled, disabledReason, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={label}
      aria-pressed={active ?? undefined}
      size={size}
      variant={variant}
      tooltip={disabled ? undefined : label}
      shortcut={disabled ? undefined : shortcut}
      disabled={disabled}
      disabledReason={disabledReason}
      className={cn(active && "bg-accent-soft text-fg hover:bg-accent-soft", className)}
      {...props}
    >
      {children}
    </Button>
  );
});
