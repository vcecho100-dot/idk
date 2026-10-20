import { useMemo } from "react";
import * as THREE from "three";
import { useSettings } from "@/stores/settings";

/** Reads a CSS custom property from :root (colors resolve through color-mix etc.). */
export function cssColor(name: string, fallback = "#808080"): THREE.Color {
  if (typeof document === "undefined") return new THREE.Color(fallback);
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const m = resolved.match(/[\d.]+/g);
  if (!m || m.length < 3) return new THREE.Color(fallback);
  const [r, g, b] = m.map(Number) as [number, number, number];
  // CSS colors are sRGB; THREE.Color stores linear working-space values.
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

export interface ViewerTokens {
  bgTop: THREE.Color;
  bgBottom: THREE.Color;
  bgSolid: THREE.Color;
  gridMinor: THREE.Color;
  gridMajor: THREE.Color;
  clay: THREE.Color;
  wire: THREE.Color;
  accentFrom: THREE.Color;
  accentTo: THREE.Color;
  checkerA: THREE.Color;
  checkerB: THREE.Color;
  dark: boolean;
}

/** Design tokens as three.js colors; recomputed when the theme or accent changes. */
export function useViewerTokens(): ViewerTokens {
  const theme = useSettings((s) => s.settings.theme);
  const accent = useSettings((s) => s.settings.accent);
  return useMemo(
    () => ({
      bgTop: cssColor("--viewport-top"),
      bgBottom: cssColor("--viewport-bottom"),
      bgSolid: cssColor("--bg"),
      gridMinor: cssColor("--grid-minor"),
      gridMajor: cssColor("--grid-major"),
      clay: cssColor("--clay"),
      wire: cssColor("--wire"),
      accentFrom: cssColor("--accent-from"),
      accentTo: cssColor("--accent-to"),
      checkerA: cssColor("--checker-a"),
      checkerB: cssColor("--checker-b"),
      dark: theme === "dark",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens change only with theme/accent
    [theme, accent],
  );
}
