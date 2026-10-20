import type { Backend } from "./api";
import { createDesktopBackend } from "./desktop";
import { IS_DESKTOP } from "@/lib/platform";

export type { Backend } from "./api";
export { BackendError, errorMessage } from "./errors";

let instance: Backend | null = null;

export async function initBackend(): Promise<Backend> {
  if (instance) return instance;
  if (IS_DESKTOP) {
    instance = createDesktopBackend();
  } else {
    // The browser engine is only loaded for the web demo / dev preview.
    const { createWebBackend } = await import("./web");
    instance = await createWebBackend();
  }
  return instance;
}

/** For tests: install a specific backend instance. */
export function setBackend(b: Backend): void {
  instance = b;
}

export function getBackend(): Backend {
  if (!instance) throw new Error("Backend used before initBackend() resolved.");
  return instance;
}
