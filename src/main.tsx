import "@/styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { App } from "@/app/App";
import { getBackend, initBackend } from "@/lib/backend";
import { useJobs } from "@/stores/jobs";
import { useLibrary } from "@/stores/library";
import { useSettings } from "@/stores/settings";

async function boot() {
  const backend = await initBackend();
  await useSettings.getState().load();
  await Promise.all([useJobs.getState().load(), useLibrary.getState().load()]);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Reveal the window only once fonts and the first frame are painted — no flash, no layout jump.
  await document.fonts.ready;
  requestAnimationFrame(() => requestAnimationFrame(() => void backend.appReady()));
}

boot().catch((err: unknown) => {
  console.error("Shift3D failed to start", err);
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = "";
    const box = document.createElement("div");
    box.className = "flex h-full items-center justify-center p-8 text-center";
    box.textContent = "Shift3D couldn't start. Please restart the app — if this keeps happening, reinstall the latest version.";
    root.appendChild(box);
  }
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err);
  try {
    void getBackend().appReady(detail);
  } catch {
    // The backend itself failed to initialise; still reveal the desktop window.
    if (isTauri()) void invoke("app_ready", { bootError: detail });
  }
});
