import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { samplesPlugin } from "./scripts/vite-samples.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Tauri sets TAURI_ENV_PLATFORM while running `tauri dev` / `tauri build`.
const isTauri = Boolean(process.env.TAURI_ENV_PLATFORM);

export default defineConfig(({ mode }) => ({
  // The web demo (GitHub Pages) is served from a sub-path, so assets must be relative.
  base: mode === "web" ? "./" : "/",
  plugins: [
    react(),
    tailwindcss(),
    samplesPlugin(fileURLToPath(new URL("./src-tauri/samples", import.meta.url)), { emit: mode === "web" }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __WEB_BUILD__: JSON.stringify(mode === "web"),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  worker: { format: "es" },
  build: {
    // WebView2 is evergreen Chromium; the web demo targets current browsers too.
    target: "chrome120",
    // Debug builds of the desktop app keep source maps; release and web builds stay lean.
    sourcemap: isTauri && Boolean(process.env.TAURI_ENV_DEBUG),
    minify: !process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 2500,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        splash: fileURLToPath(new URL("./splash.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
