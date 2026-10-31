import { expect, test, type Page } from "@playwright/test";
import { IMAGERY_TILES } from "../../src/core/imagery";
import type { Affine } from "../../src/core/types";
import { uint8Tiff, type FixtureImage } from "../unit/helpers/tiffFixtures";
import { clickAt, jumpTo, message, openApp, openRaster, paintMode, rgbFixture, settled, toScreen, type LngLat, type Xy } from "./helpers";

// Spec 020 criteria 4, 7 and 9 (e2e): full-resolution imagery tiles.
const upload = (name: string, images: FixtureImage[], gt: Affine) =>
  ({ name, mimeType: "image/tiff", buffer: Buffer.from(uint8Tiff(images, { epsg: 4326, gt })) });

/** Checkerboard, 1500 px square, tiled: the 1024 px preview samples every other pixel, so it can't show the checks. Two 8 px blocks hold 0 and 255, so every band's stretch is 0..255. */
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

test("a checkerboard shows every source pixel through the preview stretch (criterion 4)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, checkerboard());
  await expect(message(page)).toHaveText("Raster opened.");
  await zoomTo(page, CHECK_GT, 700.5, 700.5, 10);
  const o = await canvasOrigin(page);
  const pts: { c: number; r: number; at: Xy }[] = [];
  for (let r = 690; r < 712; r++) for (let c = 680; c < 722; c++) pts.push({ c, r, at: await toScreen(page, lonLat(CHECK_GT, c + 0.5, r + 0.5)) });
  const wrong = async () => {
    const f = await frame(page);
    return pts.filter(({ c, r, at }) => {
      const i = 4 * (Math.floor((at.y - o.y) * f.scale) * f.w + Math.floor((at.x - o.x) * f.scale));
      return [0, 1, 2].some((k) => Math.abs(f.px[i + k]! - check(k, c, r)) > 1);
    }).length;
  };
  await expect.poll(wrong, { timeout: 20_000 }).toBe(0);
  expect((await imagerySources(page)).length).toBeGreaterThan(0);
});

test("a painted pixel's colour edges fall on the imagery's pixel edges (criterion 4)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, checkerboard());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  while ((await page.locator("#brush-size").textContent()) !== "1") await page.click("#brush-smaller");
  const [c, r] = [600, 400];
  await zoomTo(page, CHECK_GT, c + 0.5, r + 0.5, 12);
  const centre = await toScreen(page, lonLat(CHECK_GT, c + 0.5, r + 0.5));
  // wait for the full-resolution checks at this pixel and its neighbours
  const o = await canvasOrigin(page);
  const at = (f: Awaited<ReturnType<typeof frame>>, x: number, y: number) => f.px.slice(4 * (y * f.w + x), 4 * (y * f.w + x) + 3);
  await expect.poll(async () => {
    const f = await frame(page);
    const cx = Math.floor((centre.x - o.x) * f.scale), cy = Math.floor((centre.y - o.y) * f.scale);
    return [0, 1, 2].every((k) => Math.abs(at(f, cx, cy)[k]! - check(k, c, r)) <= 1);
  }, { timeout: 20_000 }).toBe(true);
  const before = await frame(page);
  const panel = (await page.locator("#panel").boundingBox())!;
  await clickAt(page, centre);
  await settled(page);
  await page.mouse.move(panel.x + panel.width / 2, panel.y + 10); // no hover outline over the samples
  await expect.poll(async () => (await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size))).toBe(1);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const after = await frame(page);
  const cx = Math.floor((centre.x - o.x) * before.scale), cy = Math.floor((centre.y - o.y) * before.scale);
  const differs = (a: number[], b: number[]) => a.some((v, k) => Math.abs(v - b[k]!) > 8);
  for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
    // along a line through the pixel: imagery edges are where the checks change; paint edges bound the changed run
    const line = (f: typeof before, i: number) => at(f, cx + dx * i, cy + dy * i);
    const span = Math.round(30 * before.scale);
    const edges: number[] = [];
    for (let i = -span; i < span; i++) if (differs(line(before, i), line(before, i + 1))) edges.push(i + 0.5);
    const painted: number[] = [];
    for (let i = -span; i <= span; i++) if (differs(line(before, i), line(after, i))) painted.push(i);
    expect(painted.length).toBeGreaterThan(0);
    for (const e of [Math.min(...painted) - 0.5, Math.max(...painted) + 0.5]) {
      expect(Math.min(...edges.map((x) => Math.abs(x - e))), `paint edge ${e} vs imagery edges ${edges}`).toBeLessThanOrEqual(1);
    }
  }
});

test.describe("the tile cap", () => {
  test.use({ viewport: { width: 1800, height: 1400 } });
  test(`zooming across the raster never keeps more than ${IMAGERY_TILES} imagery tiles, and opening another removes them (criterion 8)`, async ({ page }) => {
    test.setTimeout(240_000);
    // 5200 px square, one band: 441 tiles at s = 1, 121 at s = 2 and 36 at s = 4
    const N = 5200, gt: Affine = [10, 0.0001, 0, 45.5, 0, -0.0001];
    const big = upload("big.tif", [{ width: N, height: N, bands: 1, value: (_k, c, r) => (c ^ r) & 255, layout: { tile: [256, 256] } }], gt);
    await openApp(page);
    await page.evaluate(() => {
      // distinct tile keys among imagery- sources: a tile's quads are ids "imagery-<key>-<i>" (spec 020 A1 counts tiles)
      const { map } = (window as any).__geoapp;
      const quads = new Map<string, number>();
      const t = { max: 0, removed: [] as string[] };
      (window as any).__tiles = t;
      const keyOf = (id: string) => id.slice("imagery-".length).replace(/-\d+$/, "");
      const add = map.addSource.bind(map), remove = map.removeSource.bind(map);
      map.addSource = (id: string, s: unknown) => {
        const r = add(id, s);
        if (id.startsWith("imagery-")) { quads.set(keyOf(id), (quads.get(keyOf(id)) ?? 0) + 1); t.max = Math.max(t.max, quads.size); }
        return r;
      };
      map.removeSource = (id: string) => {
        if (id.startsWith("imagery-")) { const k = keyOf(id), n = quads.get(k)! - 1; if (n) quads.set(k, n); else quads.delete(k); t.removed.push(id); }
        return remove(id);
      };
    });
    await openRaster(page, big);
    await expect(message(page)).toHaveText("Raster opened.", { timeout: 60_000 });
    const loaded = async () => { // the view's tiles are drawn once the count stops changing
      let last = -1;
      await expect.poll(async () => { const n = (await imagerySources(page)).length; const same = n === last; last = n; return same; }, { intervals: [400], timeout: 30_000 }).toBe(true);
    };
    for (const [css, step] of [[1.2, 1400], [0.4, 2800], [0.2, 5200]] as const) {
      for (let r = step / 3; r < N; r += step / 1.5) for (let c = step / 3; c < N; c += step / 1.5) {
        await zoomTo(page, gt, c, r, css);
        await loaded();
      }
    }
    const t = await page.evaluate(() => (window as any).__tiles);
    expect(t.max).toBeGreaterThan(IMAGERY_TILES - 64); // the zooms reached the cap
    expect(t.max).toBeLessThanOrEqual(IMAGERY_TILES);
    const old = await imagerySources(page);
    await page.evaluate(() => { (window as any).__tiles.removed = []; });
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    const removed: string[] = await page.evaluate(() => (window as any).__tiles.removed);
    expect(old.filter((id) => !removed.includes(id))).toEqual([]);
  });
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
