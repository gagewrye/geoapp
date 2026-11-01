import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
  // Pre-bundled at startup: found on the Smart select worker's first lazy import, the dev optimizer would reload the
  // page and drop the open raster and its labels (spec 046). Builds don't use the optimizer.
  optimizeDeps: { include: ["onnxruntime-web/webgpu"] },
});
