import { isTauri as tauriDetect } from "@tauri-apps/api/core";

declare global {
  const __APP_VERSION__: string;
  const __WEB_BUILD__: boolean;
}

/** True inside the Shift3D desktop app (Tauri webview). */
export const IS_DESKTOP: boolean = tauriDetect();

/** True for the GitHub Pages web demo build. */
export const IS_WEB_BUILD: boolean = __WEB_BUILD__;

export const APP_VERSION: string = __APP_VERSION__;

export const REPO_SLUG = "vcecho100-dot/idk";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
