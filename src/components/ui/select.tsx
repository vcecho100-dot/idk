import type { ReactNode } from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldClass } from "./field-class";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  className?: string;
  ariaLabel: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function Select<T extends string>({ value, onChange, options, className, ariaLabel, disabled, size = "md" }: SelectProps<T>) {
  const current = options.find((o) => o.value === value);
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <S.Trigger
        aria-label={ariaLabel}
        className={cn(
          fieldClass,
          "focus-gradient inline-flex items-center justify-between gap-2 px-2.5 text-left",
          size === "sm" ? "h-7 text-sm" : "h-8",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate [&_svg]:size-4 [&_svg]:text-subtle">
          {current?.icon}
          <S.Value>{current?.label}</S.Value>
        </span>
        <S.Icon>
          <ChevronDown className="size-3.5 text-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop surface-floating z-[66] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-panel p-1"
        >
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[6px] py-1.5 pl-2 pr-8 text-base outline-none",
                  "data-[highlighted]:bg-hover data-[disabled]:text-disabled [&_svg]:size-4 [&_svg]:text-subtle",
                )}
              >
                {o.icon}
                <div className="min-w-0">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.description && <div className="text-xs text-subtle">{o.description}</div>}
                </div>
                <S.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className="!text-accent" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
