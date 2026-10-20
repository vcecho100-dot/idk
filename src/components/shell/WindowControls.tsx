import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

/** Windows 11-style caption buttons (46px wide, thin glyphs, red close hover). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    let disposed = false;
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    void win.onResized(sync).then((fn) => {
      if (disposed) fn();
      else un = fn;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const btn = "inline-flex h-full w-[46px] items-center justify-center text-muted transition-colors duration-100 hover:text-fg focus-visible:outline-none focus-visible:bg-hover";
  return (
    <div className="flex h-full items-stretch" role="group" aria-label="Window controls">
      <button type="button" className={cn(btn, "hover:bg-hover")} aria-label="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className={cn(btn, "hover:bg-hover")}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.2" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={cn(btn, "hover:bg-[var(--window-close)] hover:text-[var(--window-close-fg)]")}
        aria-label="Close"
        onClick={() => void getCurrentWindow().close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
