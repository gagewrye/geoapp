import { expect, test, type Page } from "@playwright/test";
import { applyAffine, fromLonLat, toLonLat } from "../../src/core/crs";
import { footprint, footprintRing } from "../../src/core/pixel";
import type { Affine, Grid } from "../../src/core/types";
import { BACKGROUND, clickAt, jumpTo, message, openApp, openRaster, settled, tiff, toScreen, type LngLat } from "./helpers";

// Spec 018 criterion 3: after a dab, the colour covers exactly the pixels the hover outline marks.
// Positions and sizes are fixed; at least 10 per raster are where main's shared overlay grid put a painted
// edge 0.3 px or more from the true pixel edge (checked against main's overlayIndex when this was written).
test.use({ deviceScaleFactor: 1.25 });

const SIZE = 512;
const utm: Affine = (() => { const [x, y] = fromLonLat(32633, 18, 60); return [Math.round(x), 10, 0, Math.round(y), 0, -10]; })();
const RASTERS: [string, Grid][] = [
  ["EPSG:32633, 3 degrees off its central meridian at 60N", { epsg: 32633, gt: utm, width: SIZE, height: SIZE }],
  ["EPSG:4326 at 45N", { epsg: 4326, gt: [10, 0.0001, 0, 45.03, 0, -0.0001], width: SIZE, height: SIZE }],
  ["EPSG:4326 at 60N", { epsg: 4326, gt: [10, 0.0001, 0, 60.03, 0, -0.0001], width: SIZE, height: SIZE }],
];

/** 40 dab centres: an 8 x 5 lattice, seeded jitter, kept off the tile seams so each dab sits in one tile. */
export function positions(): [number, number][] {
  let s = 18;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: [number, number][] = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 8; i++) {
    const pick = (base: number) => { for (;;) { const v = base + Math.floor(rnd() * 40); if (Math.abs(v + 0.5 - 256) > 6) return v; } };
    out.push([pick(10 + 62 * i), pick(10 + 100 * j)]);
  }
  return out;
}

const hex = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));

/** Device-px samples every 2 px over the ring's bounds plus 8, classified against the projected ring and read in one frame. */
function samples(page: Page, ring: LngLat[]) {
  return page.evaluate(async (ring) => {
    const { map } = (window as any).__geoapp;
    const canvas: HTMLCanvasElement = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const q = ring.slice(0, 4).map((p) => { const { x, y } = map.project(p); return [x * sx, y * sy] as [number, number]; });
    // signed distance to the convex ring, positive inside, for either winding
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
          const o = 4 * ((y1 - y) * w + (x - x0)); // readPixels rows run bottom up
          out.push({ x, y, d: dist(x + 0.5, y + 0.5), px: Array.from(buf.subarray(o, o + 3)) });
        }
        resolve(out);
      });
      map.triggerRepaint();
    });
  }, ring);
}

/** Two animation frames: the label display redraws on the next one. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

for (const [name, grid] of RASTERS) {
  test(`dabs of sizes 1 and 7 cover exactly their outline: ${name} (spec 018 criterion 3)`, async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page);
    await openRaster(page, tiff("align.tif", SIZE, SIZE, 1, () => 7, { epsg: grid.epsg, gt: grid.gt }));
    await expect(message(page)).toHaveText("Raster opened.");
    // basemap and imagery hidden, so unpainted space is the background colour
    await page.evaluate(() => { const { map } = (window as any).__geoapp; for (const id of ["basemap", "preview"]) map.setLayoutProperty(id, "visibility", "none"); });
    const colour: string = await page.evaluate(() => (window as any).__geoapp.labels.classes[0].colour);
    const bg = hex(BACKGROUND), want = hex(colour).map((v, k) => 0.6 * v + 0.4 * bg[k]!);
    const lonLat = (c: number, r: number) => toLonLat(grid.epsg, ...applyAffine(grid.gt, c, r)) as LngLat;
    // a raster pixel about 16 CSS px wide
    await jumpTo(page, lonLat(256, 256), 16);
    const [a, b] = [await toScreen(page, lonLat(256, 256)), await toScreen(page, lonLat(257, 256))];
    const zoom = 16 + Math.log2(16 / Math.hypot(b.x - a.x, b.y - a.y));
    const panel = (await page.locator("#panel").boundingBox())!;

    const bad: string[] = [];
    let inside = 0, outside = 0;
    for (const [c, r] of positions()) {
      await jumpTo(page, lonLat(c + 0.5, r + 0.5), zoom);
      for (const side of [1, 7]) {
        while ((await page.locator("#brush-size").textContent()) !== `Brush: ${side} px`) await page.click(side === 1 ? "#brush-smaller" : "#brush-larger");
        await clickAt(page, await toScreen(page, lonLat(c + 0.5, r + 0.5)));
        await settled(page);
        await page.mouse.move(panel.x + panel.width / 2, panel.y + 10); // no outline over the samples
        await frames(page);
        const ring = footprintRing(grid, footprint(grid, c, r, side)!) as LngLat[];
        for (const p of await samples(page, ring)) {
          const near = (t: number[]) => p.px.every((v, k) => Math.abs(v - t[k]!) <= 3);
          if (p.d >= 1.5) { inside++; if (!near(want)) bad.push(`(${c},${r}) size ${side} inside at ${p.x},${p.y}: ${p.px}`); }
          else if (p.d <= -1.5) { outside++; if (!near(bg)) bad.push(`(${c},${r}) size ${side} outside at ${p.x},${p.y}: ${p.px}`); }
        }
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    expect(bad.slice(0, 8), `${bad.length} of ${inside + outside} samples wrong`).toEqual([]);
  });
}

for (const [name, grid] of RASTERS.slice(0, 2)) {
  test(`each stored tile adds exactly one label- layer, between the preview and the hover: ${name} (spec 018 criterion 5)`, async ({ page }) => {
    await openApp(page);
    await openRaster(page, tiff("layers.tif", SIZE, SIZE, 1, () => 7, { epsg: grid.epsg, gt: grid.gt }));
    await expect(message(page)).toHaveText("Raster opened.");
    // fill the four tiles through the hook, then recolour, which redraws every stored tile
    await page.evaluate(() => {
      const { store } = (window as any).__geoapp.labels;
      for (const k of ["0,0", "256,0", "0,256", "256,256"]) store.tiles.set(k, new Uint8Array(256 * 256).fill(1));
    });
    await page.locator("#classes .class-colour").first().fill("#ff8000");
    const ids = () => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: { id: string }) => l.id) as string[]);
    await expect.poll(async () => (await ids()).filter((id) => id.startsWith("label-")).sort()).toEqual(["label-0,0", "label-0,256", "label-256,0", "label-256,256"]);
    const lonLat = toLonLat(grid.epsg, ...applyAffine(grid.gt, 100.5, 100.5)) as LngLat;
    await jumpTo(page, lonLat, 14);
    const p = await toScreen(page, lonLat);
    await page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await ids()).some((id) => id.startsWith("brush-hover"))).toBe(true);
    const layers = await ids();
    const labelLayers = layers.filter((id) => id.startsWith("label-"));
    expect(layers).toEqual(["background", "basemap", "preview", ...labelLayers, "brush-hover-fill", "brush-hover-line"]);
  });
}
