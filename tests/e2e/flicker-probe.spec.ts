import { expect, test, type Page } from "@playwright/test";
import { BACKGROUND, message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 045 scope 1, criteria 2 and 3: step the camera (zoom +2 in 60 frames, then pitch 0 to 60 in 60 frames, 16 ms
// apart) and sample a 5x5 patch at 9 screen points on every render. bg-hits counts opaque samples within 4 of
// BACKGROUND (the basemap or imagery not drawn there); shimmer is the mean |2p[i] - p[i-1] - p[i+1]| over consecutive
// renders, per channel, of pixels opaque in all three (off the globe the canvas is transparent).
// Baseline on main (c8076f7), measured by this probe before fix B:
const BASELINE = { noRaster: { bgHits: 0, shimmer: 6.68 }, raster: { bgHits: 0, shimmer: 3.15 } };

type Result = { bgHits: number; shimmer: number; renders: number };

const probe = (page: Page) => page.evaluate(async (bg: string) => {
  const { map } = (window as any).__geoapp;
  const gl: WebGLRenderingContext = map.painter.context.gl;
  const canvas: HTMLCanvasElement = map.getCanvas();
  const ref = [1, 3, 5].map((k) => parseInt(bg.slice(k, k + 2), 16));
  const pts = [0.2, 0.5, 0.8].flatMap((fy) => [0.2, 0.5, 0.8].map((fx) => [
    Math.round(fx * canvas.width) - 2, Math.round((1 - fy) * canvas.height) - 2] as const));
  const frames: Uint8Array[][] = [];
  let bgHits = 0;
  const onRender = () => {
    frames.push(pts.map(([x, y]) => {
      const px = new Uint8Array(5 * 5 * 4);
      gl.readPixels(x, y, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3]! > 0 && [0, 1, 2].every((c) => Math.abs(px[i + c]! - ref[c]!) <= 4)) bgHits++;
      }
      return px;
    }));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const z0 = map.getZoom();
  map.on("render", onRender);
  for (let i = 1; i <= 60; i++) { map.jumpTo({ zoom: z0 + (2 * i) / 60 }); await sleep(16); }
  for (let i = 1; i <= 60; i++) { map.jumpTo({ pitch: (60 * i) / 60 }); await sleep(16); }
  await sleep(400); // a fade started by the last steps shows too
  map.off("render", onRender);
  let sum = 0, n = 0;
  for (let f = 1; f + 1 < frames.length; f++) {
    for (let p = 0; p < pts.length; p++) {
      const a = frames[f - 1]![p]!, b = frames[f]![p]!, c = frames[f + 1]![p]!;
      for (let i = 0; i < b.length; i += 4) {
        if (!a[i + 3] || !b[i + 3] || !c[i + 3]) continue;
        for (let k = 0; k < 3; k++) { sum += Math.abs(2 * b[i + k]! - a[i + k]! - c[i + k]!); n++; }
      }
    }
  }
  return { bgHits, shimmer: n ? sum / n : 0, renders: frames.length };
}, BACKGROUND);

async function run(page: Page, name: "noRaster" | "raster"): Promise<Result> {
  const r = await probe(page);
  test.info().annotations.push({ type: `probe ${name}`, description: JSON.stringify(r) });
  console.log(`flicker probe ${name}: ${JSON.stringify(r)} baseline ${JSON.stringify(BASELINE[name])}`);
  expect(r.renders).toBeGreaterThan(60);
  return r;
}

test.describe("flicker probe (spec 045)", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("no raster: bg-hits is 0 and shimmer at most half of main's", async ({ page }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const { map } = (window as any).__geoapp;
      map.jumpTo({ center: [15, 45], zoom: 3, pitch: 0 });
      await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
    });
    const r = await run(page, "noRaster");
    expect(r.bgHits).toBe(0);
    expect(r.shimmer).toBeLessThanOrEqual(BASELINE.noRaster.shimmer / 2);
  });

  test("fixture raster open: bg-hits is 0 and shimmer at most half of main's", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.evaluate(async () => {
      const { map } = (window as any).__geoapp;
      await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
    });
    const r = await run(page, "raster");
    expect(r.bgHits).toBe(0);
    expect(r.shimmer).toBeLessThanOrEqual(BASELINE.raster.shimmer / 2);
  });
});
