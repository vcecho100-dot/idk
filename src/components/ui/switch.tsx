import { Switch as S } from "radix-ui";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
  className?: string;
}

export function Switch({ checked, onCheckedChange, disabled, label, id, className }: SwitchProps) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "focus-gradient relative inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full border border-border transition-soft [--focus-radius:999px]",
        "data-[state=unchecked]:bg-active data-[state=checked]:border-transparent data-[state=checked]:bg-accent-gradient",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
    >
      <S.Thumb
        className={cn(
          "pointer-events-none block size-3.5 rounded-full shadow-soft-sm transition-transform duration-200 ease-out-soft",
          "translate-x-[1px] data-[state=checked]:translate-x-[15px]",
          "bg-muted data-[state=checked]:bg-on-accent",
        )}
      />
    </S.Root>
  );
}
