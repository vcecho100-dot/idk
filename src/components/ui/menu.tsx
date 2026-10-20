import type { ReactNode } from "react";
import { ContextMenu as CM, DropdownMenu as DM } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { Kbd } from "./kbd";
import { cn } from "@/lib/utils";

const contentClass =
  "anim-pop surface-floating z-[65] min-w-[200px] overflow-hidden rounded-panel p-1 text-base text-fg outline-none";
const itemClass = cn(
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-base outline-none",
  "data-[highlighted]:bg-hover data-[disabled]:text-disabled data-[disabled]:pointer-events-none",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-subtle data-[highlighted]:[&_svg]:text-fg",
);

interface ItemProps {
  children: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  onSelect?: (e: Event) => void;
  disabled?: boolean;
  danger?: boolean;
  /** Shown instead of the shortcut when disabled. */
  disabledReason?: string;
}

function ItemInner({ children, icon, shortcut, disabled, disabledReason }: ItemProps) {
  return (
    <>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {disabled && disabledReason ? (
        <span className="text-2xs text-disabled">{disabledReason}</span>
      ) : (
        shortcut && <Kbd keys={shortcut} />
      )}
    </>
  );
}

/* ---------------------------------- Dropdown ---------------------------------- */

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;

export function DropdownMenuContent({
  children,
  align = "start",
  side = "bottom",
  className,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <DM.Portal>
      <DM.Content align={align} side={side} sideOffset={6} collisionPadding={8} className={cn(contentClass, className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownMenuItem(props: ItemProps) {
  return (
    <DM.Item
      className={cn(itemClass, props.danger && "text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger")}
      onSelect={props.onSelect}
      disabled={props.disabled}
    >
      <ItemInner {...props} />
    </DM.Item>
  );
}

export function DropdownMenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  disabled,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <DM.CheckboxItem
      className={cn(itemClass, "pl-7")}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      onSelect={(e) => e.preventDefault()}
    >
      <DM.ItemIndicator className="absolute left-2 inline-flex">
        <Check className="!text-accent" />
      </DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">{children}</DM.Label>;
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-divider" />;
}

export function DropdownMenuSub({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <DM.Sub>
      <DM.SubTrigger className={cn(itemClass, "data-[state=open]:bg-hover")}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="!size-3.5" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent sideOffset={6} collisionPadding={8} className={contentClass}>
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}

/* -------------------------------- Context menu -------------------------------- */

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;

export function ContextMenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <CM.Portal>
      <CM.Content collisionPadding={8} className={cn(contentClass, className)}>
        {children}
      </CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuItem(props: ItemProps) {
  return (
    <CM.Item
      className={cn(itemClass, props.danger && "text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger")}
      onSelect={props.onSelect}
      disabled={props.disabled}
    >
      <ItemInner {...props} />
    </CM.Item>
  );
}

export function ContextMenuSeparator() {
  return <CM.Separator className="-mx-1 my-1 h-px bg-divider" />;
}
