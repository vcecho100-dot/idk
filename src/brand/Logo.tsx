import { useId } from "react";
import { cn } from "@/lib/utils";

interface LogoMarkProps {
  size?: number;
  className?: string;
  /** Use the user's accent instead of the fixed brand gradient. */
  accent?: boolean;
}

/** The Shift3D mark: a cube mid-transformation, half wireframe and half solid. */
export function LogoMark({ size = 20, className, accent }: LogoMarkProps) {
  const id = useId();
  const from = accent ? "var(--accent-from)" : "var(--brand-from)";
  const to = accent ? "var(--accent-to)" : "var(--brand-to)";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="10" y1="58" x2="54" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: from }} />
          <stop offset="1" style={{ stopColor: to }} />
        </linearGradient>
      </defs>
      <path d="M32 6 L54 18.5 L32 31 Z" fill={`url(#${id})`} />
      <path d="M32 31 L54 18.5 L54 45.5 L32 58 Z" fill={`url(#${id})`} />
      <path d="M32 31 L54 18.5 L54 45.5 L32 58 Z" style={{ fill: "var(--mark-shade)" }} />
      <path d="M32 6 L54 18.5 L32 31 Z" style={{ fill: "var(--mark-highlight)" }} />
      <g stroke={`url(#${id})`} strokeLinecap="round" strokeLinejoin="round">
        <path d="M32 6 L10 18.5 L32 31 M10 18.5 L10 45.5 L32 58" strokeWidth={size < 24 ? 3.2 : 2.4} />
        <path d="M10 18.5 L32 58" strokeWidth={size < 24 ? 2 : 1.4} strokeOpacity=".55" />
      </g>
      <g fill={`url(#${id})`}>
        <circle cx="10" cy="18.5" r={size < 24 ? 3.2 : 2.6} />
        <circle cx="10" cy="45.5" r={size < 24 ? 3.2 : 2.6} />
        <circle cx="32" cy="6" r={size < 24 ? 3.2 : 2.6} />
        <rect x="25.4" y="34.6" width="3.6" height="3.6" rx=".6" />
        {size >= 24 && (
          <>
            <rect x="21.6" y="41.4" width="2.8" height="2.8" rx=".5" fillOpacity=".7" />
            <rect x="26.6" y="46.2" width="2.4" height="2.4" rx=".4" fillOpacity=".45" />
          </>
        )}
      </g>
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-[-0.02em] text-fg", className)}>
      Shift<span className="bg-[linear-gradient(120deg,var(--brand-from),var(--brand-to))] bg-clip-text text-transparent">3D</span>
    </span>
  );
}

export function Logo({ size = 20, className, wordmarkClassName }: { size?: number; className?: string; wordmarkClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} />
      <Wordmark className={wordmarkClassName} />
    </span>
  );
}
