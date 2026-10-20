import "@fontsource-variable/geist/wght.css";
import "../styles/tokens.css";
import "./splash.css";

// The splash shares an origin with the main window, so it can mirror the
// user's theme/accent without any IPC permissions.
try {
  const raw = localStorage.getItem("shift3d.appearance");
  if (raw) {
    const prefs = JSON.parse(raw) as { theme?: string; accent?: string; reducedMotion?: boolean };
    const root = document.documentElement;
    if (prefs.theme === "light" || prefs.theme === "dark") root.dataset.theme = prefs.theme;
    if (typeof prefs.accent === "string") root.dataset.accent = prefs.accent;
    if (prefs.reducedMotion) root.dataset.reducedMotion = "on";
  }
} catch {
  // Storage may be unavailable; the dark default is fine.
}
