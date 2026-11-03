import { expect, test, type Page } from "@playwright/test";
import type { Affine } from "../../src/core/types";
import { uint8Tiff, type FixtureImage } from "../unit/helpers/tiffFixtures";
import { jumpTo, message, openApp, openRaster, paintMode, rgbFixture, toScreen, type LngLat } from "./helpers";

// Spec 020 criteria 8 and 9 (e2e): full-resolution imagery tiles. Criterion 4 is imagery.tester's.
const upload = (name: string, images: FixtureImage[], gt: Affine) =>
  ({ name, mimeType: "image/tiff", buffer: Buffer.from(uint8Tiff(images, { epsg: 4326, gt })) });

/** A tiled 1500 px checkerboard: imagery tiles for the removal test and the held-reads Paint test. */
const CHECK_GT: Affine = [10, 0.0001, 0, 45.1, 0, -0.0001];
const check = (k: number, c: number, r: number) => {
  if (r < 8 && c < 8) return 0;
  if (r < 8 && c < 16) return 255;
  const odd = (c + r) % 2 === 1;
  return k === 0 ? (odd ? 230 : 30) : k === 1 ? (c * 5 + r * 3) % 251 : odd ? 60 : 180;
};
const checkerboard = () => upload("check.tif", [{ width: 1500, height: 1500, bands: 3, value: check, layout: { tile: [256, 256] } }], CHECK_GT);
const lonLat = (gt: Affine, c: number, r: number): LngLat => [gt[0] + gt[1] * c, gt[3] + gt[5] * r];

/** RGBA of every device pixel of the map canvas, read in one render frame; rows top down. */
const frame = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const canvas: HTMLCanvasElement = map.getCanvas();
  return new Promise<{ w: number; h: number; px: number[]; scale: number }>((resolve) => {
    map.once("render", () => {
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
      const w = canvas.width, h = canvas.height, buf = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const out = new Array<number>(4 * w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < 4 * w; x++) out[4 * w * y + x] = buf[4 * w * (h - 1 - y) + x]!;
      resolve({ w, h, px: out, scale: w / canvas.getBoundingClientRect().width });
    });
    map.triggerRepaint();
  });
});

const canvasOrigin = (page: Page) => page.evaluate(() => { const r = (window as any).__geoapp.map.getCanvas().getBoundingClientRect(); return { x: r.left, y: r.top }; });
const imagerySources = (page: Page) => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources).filter((id) => id.startsWith("imagery-")));

/** Zoom so that one source pixel spans `css` CSS pixels at lon/lat p. */
async function zoomTo(page: Page, gt: Affine, c: number, r: number, css: number): Promise<void> {
  await jumpTo(page, lonLat(gt, c, r), 14);
  const [a, b] = [await toScreen(page, lonLat(gt, c, r)), await toScreen(page, lonLat(gt, c + 1, r))];
  await jumpTo(page, lonLat(gt, c, r), 14 + Math.log2(css / Math.hypot(b.x - a.x, b.y - a.y)));
}

// The 512-tile cap is unit-tested (map/imagery); here, opening another raster removes the tiles (spec 052).
test("opening another raster removes every imagery tile (criterion 8)", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    const removed = ((window as any).__removed = [] as string[]);
    const remove = map.removeSource.bind(map);
    map.removeSource = (id: string) => { if (id.startsWith("imagery-")) removed.push(id); return remove(id); };
  });
  await openRaster(page, checkerboard());
  await expect(message(page)).toHaveText("Raster opened.");
  await zoomTo(page, CHECK_GT, 700.5, 700.5, 2);
  await expect.poll(async () => (await imagerySources(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const old = await imagerySources(page);
  await page.evaluate(() => { (window as any).__removed.length = 0; });
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const removed: string[] = await page.evaluate(() => (window as any).__removed);
  expect(old.filter((id) => !removed.includes(id))).toEqual([]);
});

test("a single-strip file over the block limit shows the message and the preview, and no imagery tiles (criterion 9)", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { (window as any).__geoapp.fullRes.maxBlockBytes = 100_000; });
  const gt: Affine = [10, 0.001, 0, 45.2, 0, -0.001];
  await openRaster(page, upload("strip.tif", [{ width: 300, height: 200, bands: 3, value: (k, c, r) => (k === 0 ? (c < 150 ? 0 : 255) : k === 1 ? (c < 150 ? 255 : 0) : r < 100 ? 0 : 255), layout: { rows: 200 } }], gt));
  await expect(message(page)).toHaveText("Raster opened. Full resolution isn't available: this file stores pixels in 0.18 MiB blocks (limit 0.1 MiB). Re-save it tiled, e.g. gdal_translate -of COG.");
  await zoomTo(page, gt, 150, 100, 12);
  await page.waitForTimeout(500);
  expect(await imagerySources(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__geoapp.map.getLayersOrder().filter((id: string) => id.startsWith("imagery-")))).toEqual([]);
  const o = await canvasOrigin(page), p = await toScreen(page, lonLat(gt, 150.5, 100.5)), f = await frame(page);
  const i = 4 * (Math.floor((p.y - o.y) * f.scale) * f.w + Math.floor((p.x - o.x) * f.scale));
  expect(f.px.slice(i, i + 3)).toEqual([255, 0, 255]); // the preview
});

test("Paint enables once the preview shows, while the imagery tiles' reads are still held (spec 019 with spec 020)", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const g = ((window as any).__tileReads = { held: 0 });
    (window as any).__geoapp.rasterFile = (src: any) => {
      const read = src.readSamples.bind(src);
      // reads made once the preview is on the map are the tiles'; hold them for good
      src.readSamples = (...a: unknown[]) => ((window as any).__geoapp.map.getSource("preview") ? (g.held++, new Promise(() => {})) : read(...a));
    };
  });
  await openRaster(page, checkerboard());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#mode-paint")).toBeEnabled();
  await zoomTo(page, CHECK_GT, 700.5, 700.5, 10);
  await expect.poll(() => page.evaluate(() => (window as any).__tileReads.held as number)).toBeGreaterThan(0);
  expect(await imagerySources(page)).toEqual([]);
  await paintMode(page);
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
});
