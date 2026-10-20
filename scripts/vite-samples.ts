/**
 * Mock-mode sample models live in src-tauri/samples (the desktop engine embeds
 * them in its binary). This plugin serves them at /samples/* during development
 * and copies them into the web demo build — but not into the desktop bundle,
 * so the installer doesn't carry them twice.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export function samplesPlugin(dir: string, opts: { emit: boolean }): Plugin {
  const files = () => readdirSync(dir).filter((f) => /\.(glb|json)$/i.test(f));
  return {
    name: "shift3d-samples",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/samples\/([\w.-]+)$/);
        const file = match?.[1];
        if (!file || !files().includes(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "model/gltf-binary");
        res.end(readFileSync(join(dir, file)));
      });
    },
    generateBundle() {
      if (!opts.emit) return;
      for (const file of files()) {
        this.emitFile({ type: "asset", fileName: `samples/${file}`, source: readFileSync(join(dir, file)) });
      }
    },
  };
}
