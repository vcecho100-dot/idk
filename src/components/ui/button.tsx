import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { Tooltip } from "./tooltip";

const buttonVariants = cva(
  [
    "focus-gradient inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium",
    "transition-soft select-none active:scale-[0.98] disabled:pointer-events-none disabled:active:scale-100",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-accent-gradient text-on-accent shadow-soft-sm",
          "hover:brightness-110 hover:shadow-[0_6px_20px_-6px_var(--accent-glow)]",
          "disabled:opacity-45 disabled:saturate-50",
        ],
        secondary: "border border-border bg-raised text-fg shadow-inset hover:border-border-strong hover:bg-hover disabled:text-disabled",
        outline: "border border-border bg-transparent text-fg hover:bg-hover disabled:text-disabled",
        ghost: "bg-transparent text-muted hover:bg-hover hover:text-fg disabled:text-disabled",
        subtle: "bg-field text-fg hover:bg-field-hover disabled:text-disabled",
        danger: "bg-danger-soft text-danger hover:brightness-125 disabled:opacity-50",
        accent: "border border-accent-border bg-accent-softer text-fg hover:bg-accent-soft disabled:opacity-50",
      },
      size: {
        xs: "h-6 px-2 text-xs [&_svg]:size-3",
        sm: "h-7 px-2.5 text-sm [&_svg]:size-3.5",
        md: "h-8 px-3 text-base [&_svg]:size-4",
        lg: "h-10 px-4 text-md [&_svg]:size-4",
        xl: "h-12 px-5 text-md [&_svg]:size-[18px]",
        "icon-xs": "size-6 [&_svg]:size-3.5",
        "icon-sm": "size-7 [&_svg]:size-4",
        icon: "size-8 [&_svg]:size-4",
        "icon-lg": "size-9 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  /** Shown as a tooltip when the button is disabled — explains why. */
  disabledReason?: ReactNode;
  tooltip?: ReactNode;
  shortcut?: string;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    asChild,
    loading,
    disabled,
    disabledReason,
    tooltip,
    shortcut,
    icon,
    iconRight,
    children,
    type = "button",
    ...props
  },
  ref,
) {
  const isDisabled = Boolean(disabled || loading);
  const Comp = asChild ? Slot.Root : "button";
  const content = asChild ? (
    children
  ) : (
    <>
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </>
  );

  const button = (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </Comp>
  );

  if (disabled && disabledReason) {
    // Disabled buttons don't emit pointer events; the span keeps the tooltip reachable by mouse and keyboard.
    return (
      <Tooltip content={disabledReason}>
        <span tabIndex={0} className="inline-flex cursor-not-allowed rounded-control focus-visible:outline-2" aria-disabled>
          {button}
        </span>
      </Tooltip>
    );
  }
  if (tooltip || shortcut) {
    return (
      <Tooltip content={tooltip} shortcut={shortcut}>
        {button}
      </Tooltip>
    );
  }
  return button;
});

// eslint-disable-next-line react-refresh/only-export-components
export { buttonVariants };
