import { cn } from "@/lib/utils";

export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.5" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
