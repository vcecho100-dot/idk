/** Applies theme/accent/motion tokens to <html> and mirrors them for the splash window. */
export function applyAppearanceAttributes(theme: string, accent: string, reducedMotion: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
  if (reducedMotion) root.dataset.reducedMotion = "on";
  else delete root.dataset.reducedMotion;
  try {
    localStorage.setItem("shift3d.appearance", JSON.stringify({ theme, accent, reducedMotion }));
  } catch {
    /* storage unavailable */
  }
}
