import { expect, test, type Page } from "@playwright/test";
import { applyAffine, toLonLat } from "../../src/core/crs";
import { tileQuads } from "../../src/core/labelQuads";
import { footprint, footprintRing } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { writeFile } from "../unit/helpers/labelFiles";
import {
  BACKGROUND, clickAt, collectErrors, jumpTo, message, openApp, openRaster, pixelAt, RGB_GRID, rgbFixture, selectClass, settled, tiff, toScreen, type LngLat,
} from "./helpers";
import { importFile, upload } from "./seeding";

// Tester: spec 018 on tiles drawn as several quads: layers per quad, dabs on band edges, the raster edge,
// the globe, undo, a new raster, and a tile copied from an imported mask.
test.use({ deviceScaleFactor: 1.25 });

/** 0.05 deg EPSG:4326 from 84N: coarse and far north, so each tile is 128 quads of 2 rows. */
const COARSE: Grid = { epsg: 4326, gt: [10, 0.05, 0, 84, 0, -0.05], width: 512, height: 256 };
/** 0.01 deg EPSG:4326 at 45N, as rgbFixture: 8 quads per tile. */
const MID: Grid = { epsg: 4326, gt: [10, 0.01, 0, 45.5, 0, -0.01], width: 512, height: 256 };
const hex = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
const near = (p: number[], t: number[]) => p.every((v, k) => Math.abs(v - t[k]!) <= 3);
const layerIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: { id: string }) => l.id) as string[]);
const labelLayers = async (page: Page) => (await layerIds(page)).filter((id) => id.startsWith("label-")).sort();
const labelSources = (page: Page) => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources).filter((id) => id.startsWith("label-")).sort());
const hideAll = (page: Page) => page.evaluate(() => { const { map } = (window as any).__geoapp; for (const id of ["basemap", "preview"]) map.setLayoutProperty(id, "visibility", "none"); });
const setLabelsVisible = (page: Page, on: boolean) => page.evaluate((on) => {
  const { map } = (window as any).__geoapp;
  for (const l of map.getStyle().layers) if (l.id.startsWith("label-")) map.setLayoutProperty(l.id, "visibility", on ? "visible" : "none");
}, on);
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const offMap = async (page: Page) => { const b = (await page.locator("#panel").boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + 10); };
const classColour = (page: Page): Promise<string> => page.evaluate(() => (window as any).__geoapp.labels.classes[0].colour);

/** Device-px samples every 2 px over the ring's bounds plus 8: signed distance to the projected ring (inside positive) and colour. */
function samples(page: Page, ring: LngLat[]) {
  return page.evaluate(async (ring) => {
    const { map } = (window as any).__geoapp;
    const canvas: HTMLCanvasElement = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const q = ring.slice(0, 4).map((p) => { const { x, y } = map.project(p); return [x * sx, y * sy] as [number, number]; });
    const area = q.reduce((a, p, i) => { const n = q[(i + 1) % 4]!; return a + p[0] * n[1] - n[0] * p[1]; }, 0);
    const dist = (x: number, y: number) => Math.min(...q.map((p, i) => {
      const n = q[(i + 1) % 4]!, ex = n[0] - p[0], ey = n[1] - p[1];
      return (Math.sign(area) * (ex * (y - p[1]) - ey * (x - p[0]))) / Math.hypot(ex, ey);
    }));
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - 8)), x1 = Math.min(canvas.width - 1, Math.ceil(Math.max(...xs) + 8));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - 8)), y1 = Math.min(canvas.height - 1, Math.ceil(Math.max(...ys) + 8));
    return new Promise<{ x: number; y: number; d: number; px: number[] }[]>((resolve) => {
      map.once("render", () => {
        const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
        const w = x1 - x0 + 1, h = y1 - y0 + 1, buf = new Uint8Array(4 * w * h);
        gl.readPixels(x0, canvas.height - 1 - y1, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const out: { x: number; y: number; d: number; px: number[] }[] = [];
        for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
          const o = 4 * ((y1 - y) * w + (x - x0));
          out.push({ x, y, d: dist(x + 0.5, y + 0.5), px: Array.from(buf.subarray(o, o + 3)) });
        }
        resolve(out);
      });
      map.triggerRepaint();
    });
  }, ring);
}

/** Opens grid as a one-band raster, imagery and basemap hidden, at a pixel about 16 CSS px wide around (c, r). */
async function openAt(page: Page, grid: Grid, c: number, r: number) {
  await openApp(page);
  await openRaster(page, tiff("quads.tif", grid.width, grid.height, 1, () => 7, { epsg: grid.epsg, gt: grid.gt }));
  await expect(message(page)).toHaveText("Raster opened.");
  await hideAll(page);
  const lonLat = (x: number, y: number) => toLonLat(grid.epsg, ...applyAffine(grid.gt, x, y)) as LngLat;
  await jumpTo(page, lonLat(c, r), 8);
  const [a, b] = [await toScreen(page, lonLat(c, r)), await toScreen(page, lonLat(c + 1, r))];
  await jumpTo(page, lonLat(c, r), 8 + Math.log2(16 / Math.hypot(b.x - a.x, b.y - a.y)));
  while ((await page.locator("#brush-size").textContent()) !== "Brush: 7 px") await page.click("#brush-larger");
  return lonLat;
}

test("a 128-quad tile: one layer per quad; size-7 dabs on the raster's top edge, a band edge and inside a band cover exactly their outline; undo and a new raster remove every quad", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const quads = tileQuads(COARSE, { x0: 0, y0: 0, width: 256, height: 256 }, 0.05);
  expect(quads.length).toBe(128);
  const lonLat = await openAt(page, COARSE, 100, 100);
  // MapLibre's globe is not flat at this zoom, and map.project there disagrees with what it draws; Mercator
  // isolates the quads (the globe is checked against the hover below)
  await page.evaluate(() => (window as any).__geoapp.map.setProjection({ type: "mercator" }));
  const colour = await classColour(page);
  const bg = hex(BACKGROUND), want = hex(colour).map((v, k) => 0.6 * v + 0.4 * bg[k]!);
  const bad: string[] = [];
  for (const [c, r] of [[100, 2], [100, 100], [180, 151], [250, 254]] as const) {
    await jumpTo(page, lonLat(c + 0.5, r + 0.5), await page.evaluate(() => (window as any).__geoapp.map.getZoom()));
    await clickAt(page, await toScreen(page, lonLat(c + 0.5, r + 0.5)));
    await settled(page);
    await offMap(page);
    await frames(page);
    for (const p of await samples(page, footprintRing(COARSE, footprint(COARSE, c, r, 7)!) as LngLat[])) {
      if (p.d >= 1.5 && !near(p.px, want)) bad.push(`(${c},${r}) inside ${p.x},${p.y}: ${p.px}`);
      if (p.d <= -1.5 && !near(p.px, bg)) bad.push(`(${c},${r}) outside ${p.x},${p.y}: ${p.px}`);
    }
  }
  expect(bad.slice(0, 8), `${bad.length} samples wrong`).toEqual([]);
  const ids = quads.map((_, i) => `label-0,0-${i}`).sort();
  expect(await labelLayers(page)).toEqual(ids);
  expect(await labelSources(page)).toEqual(ids);

  for (let i = 0; i < 4; i++) await page.click("#undo");
  await expect.poll(() => labelLayers(page)).toEqual([]);
  expect(await labelSources(page)).toEqual([]);

  await clickAt(page, await toScreen(page, lonLat(250.5, 254.5)));
  await settled(page);
  await expect.poll(() => labelLayers(page)).toEqual(ids);
  page.on("dialog", (d) => void d.accept()); // discard the labels
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect.poll(() => labelLayers(page)).toEqual([]);
  expect(await labelSources(page)).toEqual([]);
  expect(errors).toEqual([]);
});

for (const [name, grid] of [["0.05 deg at 84N, 128 quads", COARSE], ["0.01 deg at 45N, 8 quads", MID]] as const) {
  test(`on the globe (default projection), the paint of a size-7 dab matches its hover outline: ${name}`, async ({ page }) => {
    test.setTimeout(120_000);
    const lonLat = await openAt(page, grid, 100, 101);
    const at = await toScreen(page, lonLat(100.5, 101.5));
    await clickAt(page, at);
    await settled(page);
    await offMap(page);
    await frames(page);
    const ring = footprintRing(grid, footprint(grid, 100, 101, 7)!) as LngLat[];
    const painted = (await samples(page, ring)).map((p) => near(p.px, hex(BACKGROUND)) ? 0 : 1);
    // now the outline alone: hover on, labels hidden
    await page.mouse.move(at.x, at.y);
    await setLabelsVisible(page, false);
    await frames(page);
    const hs = await samples(page, ring);
    const hover = hs.map((p) => (near(p.px, hex(BACKGROUND)) ? 0 : 1));
    expect(hover.some((v) => v) && painted.some((v) => v)).toBe(true);
    // index grid of the samples, to find hover edges
    const xs = [...new Set(hs.map((p) => p.x))];
    const H = (i: number, j: number) => hover[j * xs.length + i] ?? -1;
    const bad: string[] = [];
    hs.forEach((p, k) => {
      if (painted[k] === hover[k]) return;
      const i = k % xs.length, j = Math.floor(k / xs.length);
      // a disagreement is allowed only next to the hover's edge (one 2-px sample: its line and rounding)
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => { const v = H(i + di!, j + dj!); return v !== -1 && v !== hover[k]; });
      if (!edge) bad.push(`${p.x},${p.y}: painted ${painted[k]} hover ${hover[k]}`);
    });
    expect(bad.slice(0, 8), `${bad.length} of ${hs.length} samples disagree away from the outline edge`).toEqual([]);
  });
}

test("a tile copied from an imported mask is drawn as its quads, above the mask; undo shows the mask there again", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  // the mask: value 2 everywhere (GDAL_NODATA 0), so the tile under the dab reads class 2 until touched
  const v = new Uint8Array(1000 * 1000).fill(2);
  await importFile(page, upload("mask.tif", writeFile(RGB_GRID, 1, v, "0", { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 })));
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  await page.click("#mode-paint");
  await hideAll(page);
  await selectClass(page, 0);
  const quads = tileQuads(RGB_GRID, { x0: 256, y0: 256, width: 256, height: 256 }, 0.05);
  const lonLat = (x: number, y: number) => toLonLat(4326, ...applyAffine(RGB_GRID.gt, x, y)) as LngLat;
  await jumpTo(page, lonLat(300.5, 300.5), 12);
  const probe = await toScreen(page, lonLat(300.5, 300.5));
  await offMap(page);
  await frames(page);
  const before = await pixelAt(page, probe);

  await clickAt(page, probe);
  await settled(page);
  const ids = quads.length === 1 ? ["label-256,256"] : quads.map((_, i) => `label-256,256-${i}`).sort();
  await expect.poll(() => labelLayers(page)).toEqual(ids);
  const layers = await layerIds(page);
  expect(layers.indexOf("mask")).toBeLessThan(Math.min(...ids.map((id) => layers.indexOf(id))));
  await offMap(page);
  await frames(page);
  const want = hex(await classColour(page)).map((v, k) => 0.6 * v + 0.4 * hex(BACKGROUND)[k]!);
  await expect.poll(async () => near((await pixelAt(page, probe)).slice(0, 3), want)).toBe(true);

  await page.click("#undo");
  const keys: string[] = await page.evaluate(() => [...(window as any).__geoapp.labels.store.tiles.keys()]);
  await expect.poll(() => labelLayers(page)).toEqual(keys.includes("256,256") ? ids : []);
  await expect.poll(async () => (await pixelAt(page, probe)).slice(0, 3)).toEqual(before.slice(0, 3));
});
