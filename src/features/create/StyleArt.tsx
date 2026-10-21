import { useId } from "react";
import type { Style } from "@/lib/backend/types";

/** Small illustrations for the style cards, drawn from theme tokens. */
export function StyleArt({ style }: { style: Style }) {
  const id = useId();
  const g = `url(#${id})`;
  return (
    <svg viewBox="0 0 64 48" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--accent-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--accent-to)" }} />
        </linearGradient>
        <radialGradient id={`${id}r`} cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" style={{ stopColor: "var(--text)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--text-subtle)" }} />
          <stop offset="1" style={{ stopColor: "var(--panel-raised)" }} />
        </radialGradient>
      </defs>
      {style === "realistic" && (
        <>
          <ellipse cx="32" cy="41" rx="14" ry="2.5" style={{ fill: "var(--overlay)" }} />
          <circle cx="32" cy="24" r="15" fill={`url(#${id}r)`} />
          <circle cx="27" cy="18" r="3.5" style={{ fill: "var(--text)" }} opacity=".7" />
        </>
      )}
      {style === "stylized" && (
        <>
          <path d="M32 7 L49 16 L49 33 L32 42 L15 33 L15 16 Z" fill={g} />
          <path d="M32 24 L49 16 L49 33 L32 42 Z" style={{ fill: "var(--mark-shade)" }} />
          <path d="M15 16 L32 7 L49 16 L32 24 Z" style={{ fill: "var(--mark-highlight)" }} />
        </>
      )}
      {style === "cartoon" && (
        <>
          <path d="M17 31 C14 17 24 8 33 9 C44 10 51 20 47 32 C45 39 22 41 17 31 Z" fill={g} style={{ stroke: "var(--text)" }} strokeWidth="2.2" />
          <circle cx="27" cy="22" r="3" style={{ fill: "var(--text)" }} />
          <circle cx="38" cy="22" r="3" style={{ fill: "var(--text)" }} />
          <path d="M27 30 Q32.5 34 38 30" style={{ stroke: "var(--text)" }} strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      )}
      {style === "lowpoly" && (
        <>
          <path d="M32 6 L48 18 L43 38 L21 38 L16 18 Z" fill={g} />
          <path d="M32 6 L32 24 L16 18 Z" style={{ fill: "var(--mark-highlight)" }} />
          <path d="M32 24 L43 38 L21 38 Z" style={{ fill: "var(--mark-shade)" }} />
          <path d="M32 24 L48 18 L43 38 Z" style={{ fill: "var(--mark-shade)" }} opacity=".6" />
          <path d="M32 6 L32 24 L48 18 M32 24 L21 38 M32 24 L16 18" style={{ stroke: "var(--text)" }} strokeOpacity=".25" fill="none" />
        </>
      )}
      {style === "voxel" && (
        <g>
          {[
            [24, 26],
            [32, 26],
            [40, 26],
            [28, 18],
            [36, 18],
            [32, 10],
          ].map(([x, y], i) => (
            <g key={i} transform={`translate(${x! - 4} ${y})`}>
              <rect width="8" height="8" fill={g} />
              <rect width="8" height="2" style={{ fill: "var(--mark-highlight)" }} />
              <rect x="6" width="2" height="8" style={{ fill: "var(--mark-shade)" }} />
            </g>
          ))}
        </g>
      )}
      {style === "sculpture" && (
        <>
          <rect x="22" y="36" width="20" height="6" rx="1" style={{ fill: "var(--text-subtle)" }} />
          <path d="M25 36 C24 30 26 28 29 27 C25 24 25 13 32 12 C39 13 39 24 35 27 C38 28 40 30 39 36 Z" fill={`url(#${id}r)`} />
        </>
      )}
    </svg>
  );
}
