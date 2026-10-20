import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

interface DialogContentProps {
  children: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  hideClose?: boolean;
  /** Visually hide the header (title stays accessible). */
  bare?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
}

export function DialogContent({ children, title, description, className, hideClose, bare, onOpenAutoFocus }: DialogContentProps) {
  return (
    <D.Portal>
      <D.Overlay className="anim-fade fixed inset-0 z-[60] bg-overlay backdrop-blur-[2px]" />
      <D.Content
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          "anim-dialog fixed left-1/2 top-1/2 z-[61] flex max-h-[min(720px,calc(100vh-64px))] w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col",
          "rounded-panel border border-border bg-raised shadow-soft-lg outline-none",
          className,
        )}
      >
        <div className={cn("flex items-start justify-between gap-4 px-5 pb-3 pt-4", bare && "sr-only")}>
          <div className="min-w-0">
            <D.Title className="text-md font-semibold tracking-tight text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
            )}
          </div>
          {!hideClose && (
            <D.Close
              className="focus-gradient -mr-1.5 -mt-0.5 inline-flex size-7 items-center justify-center rounded-control text-subtle transition-soft hover:bg-hover hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" />
            </D.Close>
          )}
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-4", className)}>{children}</div>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-end gap-2 border-t border-divider px-5 py-3", className)}>{children}</div>
  );
}
