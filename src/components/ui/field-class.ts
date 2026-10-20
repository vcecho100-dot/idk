import { cn } from "@/lib/utils";

/** Shared look for text inputs, textareas and select triggers. */
export const fieldClass = cn(
  "w-full rounded-control border border-border bg-field text-base text-fg placeholder:text-subtle",
  "transition-soft hover:bg-field-hover hover:border-border-strong",
  "focus:border-accent-border focus:bg-field focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-softer)]",
  "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
);
