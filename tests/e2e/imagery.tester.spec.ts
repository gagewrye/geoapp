import { expect, test, type Page } from "@playwright/test";
import { writeArrayBuffer } from "geotiff";
import { applyAffine, fromLonLat, toLonLat } from "../../src/core/crs";
import type { Affine } from "../../src/core/types";
import { clickAt, jumpTo, message, openApp, openRaster, paintMode, settled, toScreen, type LngLat } from "./helpers";

// Spec 020 criterion 4, tester: imagery pixels and painted pixels on a rotated UTM grid at 45N (not only the 4326 checkerboard).
// The preview is hidden, so every colour checked comes from the full-resolution tiles.

const N = 700;
/** EPSG:32618 at 45N, 76.3W (1.3 degrees off the central meridian), 0.5 m pixels rotated 25 degrees. */
const GT: Affine = (() => {
  const t = (25 * Math.PI) / 180, p = 0.5, [x, y] = fromLonLat(32618, -76.3, 45);
  return [x, p * Math.cos(t), p * Math.sin(t), y, p * Math.sin(t), -p * Math.cos(t)];
})();
/** Checks in band 0 and 2, a ramp in band 1; two 8 px blocks hold 0 and 255 so each band stretches over 0..255. */
const value = (k: number, c: number, r: number) => {
  if (r < 8 && c < 8) return 0;
  if (r < 8 && c < 16) return 255;
  const odd = (c + r) % 2 === 1;
  return k === 0 ? (odd ? 230 : 30) : k === 1 ? (c * 5 + r * 3) % 251 : odd ? 60 : 180;
};

function rotatedFixture() {
  const vals = new Float32Array(N * N * 3);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) for (let k = 0; k < 3; k++) vals[(r * N + c) * 3 + k] = value(k, c, r);
  const m = [GT[1], GT[2], 0, GT[0], GT[4], GT[5], 0, GT[3], 0, 0, 0, 0, 0, 0, 0, 1];
  const buf = writeArrayBuffer(vals, { width: N, height: N, SamplesPerPixel: 3, ModelTransformation: m, GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32618, GTRasterTypeGeoKey: 1 });
  return { name: "rotated.tif", mimeType: "image/tiff", buffer: Buffer.from(buf) };
}

const lonLat = (c: number, r: number) => toLonLat(32618, ...applyAffine(GT, c, r)) as LngLat;

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
type Frame = Awaited<ReturnType<typeof frame>>;

const canvasOrigin = (page: Page) => page.evaluate(() => { const r = (window as any).__geoapp.map.getCanvas().getBoundingClientRect(); return { x: r.left, y: r.top }; });
const imagerySources = (page: Page) => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources).filter((id) => id.startsWith("imagery-")).length);
const hidePreview = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.setLayoutProperty("preview", "visibility", "none"));

async function zoomTo(page: Page, c: number, r: number, css: number): Promise<void> {
  await jumpTo(page, lonLat(c, r), 18);
  const [a, b] = [await toScreen(page, lonLat(c, r)), await toScreen(page, lonLat(c + 1, r))];
  await jumpTo(page, lonLat(c, r), 18 + Math.log2(css / Math.hypot(b.x - a.x, b.y - a.y)));
}

async function openRotated(page: Page): Promise<void> {
  await openApp(page);
  await openRaster(page, rotatedFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await hidePreview(page);
}

test("rotated UTM at 45N: screen samples at pixel centres match the source, from the tiles alone", async ({ page }) => {
  await openRotated(page);
  await zoomTo(page, 350.5, 350.5, 10);
  const o = await canvasOrigin(page);
  const pts: { c: number; r: number; at: { x: number; y: number } }[] = [];
  for (let r = 340; r < 362; r++) for (let c = 330; c < 372; c++) pts.push({ c, r, at: await toScreen(page, lonLat(c + 0.5, r + 0.5)) });
  const wrong = async () => {
    const f = await frame(page);
    return pts.filter(({ c, r, at }) => {
      const x = Math.floor((at.x - o.x) * f.scale), y = Math.floor((at.y - o.y) * f.scale);
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) return false;
      const i = 4 * (y * f.w + x);
      return [0, 1, 2].some((k) => Math.abs(f.px[i + k]! - value(k, c, r)) > 1);
    }).length;
  };
  await expect.poll(wrong, { timeout: 30_000 }).toBe(0);
  expect(await imagerySources(page)).toBeGreaterThan(0);
});

test("rotated UTM at 45N: a painted pixel's colour edges fall on the imagery's pixel edges, within 1 device px", async ({ page }) => {
  await openRotated(page);
  await paintMode(page);
  while ((await page.locator("#brush-size").textContent()) !== "Brush: 1 px") await page.click("#brush-smaller");
  const [c, r] = [420, 300];
  await zoomTo(page, c + 0.5, r + 0.5, 14);
  const centre = await toScreen(page, lonLat(c + 0.5, r + 0.5));
  const o = await canvasOrigin(page);
  const at = (f: Frame, x: number, y: number) => f.px.slice(4 * (y * f.w + x), 4 * (y * f.w + x) + 3);
  await expect.poll(async () => {
    const f = await frame(page);
    const cx = Math.floor((centre.x - o.x) * f.scale), cy = Math.floor((centre.y - o.y) * f.scale);
    return [0, 1, 2].every((k) => Math.abs(at(f, cx, cy)[k]! - value(k, c, r)) <= 1);
  }, { timeout: 30_000 }).toBe(true);
  const panel = (await page.locator("#panel").boundingBox())!;
  await page.mouse.move(panel.x + panel.width / 2, panel.y + 10);
  const before = await frame(page);
  await clickAt(page, centre);
  await settled(page);
  await page.mouse.move(panel.x + panel.width / 2, panel.y + 10); // no hover outline over the samples
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(1);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const after = await frame(page);
  const cx = Math.floor((centre.x - o.x) * before.scale), cy = Math.floor((centre.y - o.y) * before.scale);
  const differs = (a: number[], b: number[]) => a.some((v, k) => Math.abs(v - b[k]!) > 8);
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]] as const) {
    const line = (f: Frame, i: number) => at(f, cx + dx * i, cy + dy * i);
    const span = Math.round(40 * before.scale);
    const edges: number[] = [];
    for (let i = -span; i < span; i++) if (differs(line(before, i), line(before, i + 1))) edges.push(i + 0.5);
    const painted: number[] = [];
    for (let i = -span; i <= span; i++) if (differs(line(before, i), line(after, i))) painted.push(i);
    expect(painted.length).toBeGreaterThan(2);
    for (const e of [Math.min(...painted) - 0.5, Math.max(...painted) + 0.5]) {
      expect(Math.min(...edges.map((x) => Math.abs(x - e))), `direction ${dx},${dy}: paint edge ${e} vs imagery edges ${edges}`).toBeLessThanOrEqual(1);
    }
  }
});

test("A1 read failures: a failing tile read says imageryUnreadable once per raster, the tile is read again later, and Paint still works", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const g = ((window as any).__fail = { on: false, failed: 0 });
    (window as any).__geoapp.pauseMasks = true; // spec 023: only the tiles' reads, not background mask reads, run and fail
    (window as any).__geoapp.rasterFile = (src: any) => {
      const read = src.readSamples.bind(src);
      // only reads made once this raster's preview is on the map are the tiles' (showPreview adds a new source)
      const { map } = (window as any).__geoapp, old = map.getSource("preview");
      const tiles = () => { const p = map.getSource("preview"); return p !== undefined && p !== old; };
      src.readSamples = (...a: unknown[]) => (g.on && tiles() ? (g.failed++, Promise.reject(new ProgressEvent("error"))) : read(...a));
    };
  });
  const unreadable = "Couldn't read part of this file, so some detail may be missing.";
  const fail = (on: boolean) => page.evaluate((on) => { (window as any).__fail.on = on; }, on);
  await fail(true); // the fitted view's tiles fail too, so no tile is ever drawn
  await openRaster(page, rotatedFixture());
  await expect(page.locator("#mode-paint")).toBeEnabled();
  await zoomTo(page, 350.5, 350.5, 10);
  await expect(message(page)).toHaveText(unreadable);
  expect(await imagerySources(page)).toBe(0);
  await page.locator("#message").evaluate((el) => { el.textContent = "marker"; });
  await zoomTo(page, 360.5, 350.5, 10); // fails again: no second message for this raster
  await expect.poll(() => page.evaluate(() => (window as any).__fail.failed as number)).toBeGreaterThan(1);
  await expect(message(page)).toHaveText("marker");
  await fail(false);
  await zoomTo(page, 350.5, 350.5, 10); // the same tiles are asked for again and drawn
  await expect.poll(() => imagerySources(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await paintMode(page);
  // another open: a failure is reported again. Failing from the start, as for the first open: the fitted view
  // may need every tile, so once they have loaded no zoom reads anything new
  const before = await page.evaluate(() => (window as any).__fail.failed as number);
  await fail(true);
  await openRaster(page, { ...rotatedFixture(), name: "again.tif" });
  await expect(page.locator("#mode-paint")).toBeEnabled();
  await zoomTo(page, 300.5, 300.5, 10);
  await expect.poll(() => page.evaluate(() => (window as any).__fail.failed as number)).toBeGreaterThan(before);
  await expect(message(page)).toHaveText(unreadable);
});
