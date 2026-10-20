import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { fieldClass } from "./field-class";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, ...props },
  ref,
) {
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(fieldClass, "h-8 px-2.5", className)} spellCheck={false} {...props} />;
  }
  return (
    <div className={cn("relative flex items-center", className)}>
      {leading && (
        <span className="pointer-events-none absolute left-2.5 flex text-subtle [&_svg]:size-4">{leading}</span>
      )}
      <input
        ref={ref}
        className={cn(fieldClass, "h-8", leading ? "pl-8" : "pl-2.5", trailing ? "pr-9" : "pr-2.5")}
        spellCheck={false}
        {...props}
      />
      {trailing && <span className="absolute right-1 flex items-center">{trailing}</span>}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldClass, "resize-none px-3 py-2.5 leading-5", className)} {...props} />;
});

export function Label({ children, htmlFor, className, hint }: { children: ReactNode; htmlFor?: string; className?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className={cn("flex items-baseline justify-between gap-2 text-sm font-medium text-muted", className)}>
      <span>{children}</span>
      {hint && <span className="text-xs font-normal text-subtle">{hint}</span>}
    </label>
  );
}
