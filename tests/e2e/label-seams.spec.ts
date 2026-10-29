import { expect, test, type Page } from "@playwright/test";
import { applyAffine, fromLonLat, toLonLat } from "../../src/core/crs";
import type { Affine } from "../../src/core/types";
import { hideBasemap, jumpTo, message, openApp, openRaster, tiff, toScreen, type LngLat, type Xy } from "./helpers";

// Spec 011 criterion 5: label overlays meet at tile seams with no gaps and no double-opacity strips.
// EPSG:32633, 3 degrees east of its central meridian at 60N, 10 m pixels (as the unit test's synthetic grid).
const GT: Affine = (() => { const [x, y] = fromLonLat(32633, 18, 60); return [Math.round(x), 10, 0, Math.round(y), 0, -10]; })();
const SIZE = 512;
const lonLat = (c: number, r: number): LngLat => toLonLat(32633, ...applyAffine(GT, c, r)) as LngLat;

/** RGBA of the rendered canvas at many page points, all read in one render frame. */
function pixelsAt(page: Page, pts: Xy[]): Promise<number[][]> {
  return page.evaluate(async (pts) => {
    const { map } = (window as any).__geoapp;
    const canvas: HTMLCanvasElement = map.getCanvas();
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    return new Promise<number[][]>((resolve) => {
      map.once("render", () => {
        const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
        resolve(pts.map((p) => {
          const px = new Uint8Array(4);
          gl.readPixels(Math.round((p.x - r.left) * sx), Math.round(canvas.height - (p.y - r.top) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return Array.from(px);
        }));
      });
      map.triggerRepaint();
    });
  }, pts);
}

/** Page points of raster positions, projected in the page. */
const project = (page: Page, lls: LngLat[]): Promise<Xy[]> => page.evaluate((lls) => {
  const { map } = (window as any).__geoapp;
  const r = map.getCanvas().getBoundingClientRect();
  return lls.map((p) => { const { x, y } = map.project(p); return { x: r.left + x, y: r.top + y }; });
}, lls);

test("painted 2x2-tile block: points 0.25 px either side of each seam equal the interior colour (spec 011 criterion 5)", async ({ page }) => {
  // Sub-pixel hairlines from MapLibre rounding each source's corners remain (spec 011 Out, ADR 0016),
  // so up to 2% of samples may differ; the pre-fix design differed on about 38%.
  test.setTimeout(120_000);
  await openApp(page);
  await hideBasemap(page);
  await openRaster(page, tiff("seams.tif", SIZE, SIZE, 1, () => 7, { epsg: 32633, gt: GT }));
  await expect(message(page)).toHaveText("Raster opened.");
  await page.click("#mode-pan"); // no footprint over the samples
  // fill the block through the hook, then recolour, which redraws every stored tile
  await page.evaluate(() => {
    const { store } = (window as any).__geoapp.labels;
    for (const k of ["0,0", "256,0", "0,256", "256,256"]) store.tiles.set(k, new Uint8Array(256 * 256).fill(1));
  });
  await page.locator("#classes .class-colour").first().fill("#ff8000");
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.filter((l: any) => l.id.startsWith("label-")).length)).toBe(4);

  // zoom so one raster pixel is about 4 screen px
  await jumpTo(page, lonLat(256, 256), 14);
  const [a, b] = [await toScreen(page, lonLat(256, 256)), await toScreen(page, lonLat(257, 256))];
  const zoom = 14 + Math.log2(4 / Math.hypot(b.x - a.x, b.y - a.y));

  // seam positions every 2 raster px (8 screen px), away from the block's outer edge; viewed in stretches
  const seams: { name: string; at: (t: number, side: number) => LngLat }[] = [
    { name: "column 256", at: (t, s) => lonLat(256 + s * 0.25, t) },
    { name: "row 256", at: (t, s) => lonLat(t, 256 + s * 0.25) },
  ];
  const bad: string[] = [];
  let checked = 0;
  for (const seam of seams) {
    for (let start = 4; start < SIZE - 4; start += 80) {
      const ts = Array.from({ length: 40 }, (_, i) => start + 2 * i).filter((t) => t < SIZE - 4);
      await jumpTo(page, seam.at(ts[Math.floor(ts.length / 2)]!, 0), zoom);
      // the interior colour, from the middle of the tile beside this stretch
      const mid = ts[Math.floor(ts.length / 2)]!;
      const [interior] = await pixelsAt(page, await project(page, [seam.at(mid, -40)]));
      const lls = ts.flatMap((t) => [seam.at(t, -1), seam.at(t, 1)]);
      const px = await pixelsAt(page, await project(page, lls));
      px.forEach((p, i) => {
        checked++;
        if (!p.slice(0, 3).every((v, k) => Math.abs(v - interior![k]!) <= 2)) bad.push(`${seam.name} t=${ts[i >> 1]} side ${i & 1 ? "+" : "-"}: ${p} vs ${interior}`);
      });
    }
  }
  expect(checked).toBeGreaterThanOrEqual(900);
  console.log(`spec 011 criterion 5: ${bad.length} of ${checked} seam samples differ (${((100 * bad.length) / checked).toFixed(2)}%)`);
  expect(bad.length / checked, `${bad.length} of ${checked} samples differ, e.g. ${bad.slice(0, 5).join("; ")}`).toBeLessThanOrEqual(0.02);
});
