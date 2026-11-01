import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../vite.config";

// Spec 046 bug (Gage, 2026-10-31): in dev, the first Smart select load made Vite's dep optimizer discover
// onnxruntime-web, re-optimise and reload the page, which dropped the open raster and its labels.
describe("vite config", () => {
  it("pre-bundles every onnxruntime-web module the worker imports, so its first load can't reload the page", () => {
    const worker = readFileSync("src/io/segmenterWorker.ts", "utf8");
    const dynamic = [...new Set([...worker.matchAll(/import\("(onnxruntime-web[^"]*)"\)/g)].map((m) => m[1]))]; // the type import names it too
    expect(dynamic).toEqual(["onnxruntime-web/webgpu"]);
    for (const dep of dynamic) expect(config.optimizeDeps?.include ?? []).toContain(dep);
  });
});
