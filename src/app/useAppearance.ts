import { useEffect } from "react";
import { getBackend } from "@/lib/backend";
import { useSettings } from "@/stores/settings";

/** Matches the native window (Mica backdrop, title-bar theme) to the app theme. */
export function useAppearance(): void {
  const theme = useSettings((s) => s.settings.theme);
  const mica = useSettings((s) => s.settings.mica);

  useEffect(() => {
    let cancelled = false;
    void getBackend()
      .setWindowAppearance(theme, mica)
      .then((active) => {
        if (cancelled) return;
        if (active) document.documentElement.dataset.mica = "on";
        else delete document.documentElement.dataset.mica;
      })
      .catch(() => delete document.documentElement.dataset.mica);
    return () => {
      cancelled = true;
    };
  }, [theme, mica]);
}
