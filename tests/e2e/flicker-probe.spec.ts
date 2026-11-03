import { expect, test, type Page } from "@playwright/test";
import { BACKGROUND, message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 045 scope 1, criteria 2 and 3: with the fixture raster open, step the camera (pan north 2 px a frame for 60 frames,
// then zoom +0.5 and pitch +15 degrees in 30 frames each, a render per frame) and screenshot the top 60 px of #map each
// frame, so what was composited counts, transparent pixels included. pops is the share of band pixels within 8 of
// BACKGROUND in frame i and more than 40 from it in frames i-1 and i+1, or the reverse.
// On main (c8076f7 code), measured by this probe before the maxzoom fix:
const MAIN = { "z15.7": "4.087%", "z11.9": "0.000%", z9: "0.000%" };

const RUNS = [
  { name: "z15.7", zoom: 15.7, pitch: 30 },
  { name: "z11.9", zoom: 11.9, pitch: 30 },
  { name: "z9", zoom: 9, pitch: 45 },
] as const;
// over land west of the raster (10-20E), so the band shows the basemap, not the imagery
const CENTRE = [8.5, 45.5];

/** Classifies a screenshot's pixels in the page: 0 within 8 of BACKGROUND, 1 more than 40 from it, 2 between. */
const keep = (page: Page, png: Buffer) => page.evaluate(async ([b64, bg]) => {
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data, ref = [1, 3, 5].map((k) => parseInt(bg.slice(k, k + 2), 16));
  const cls = new Uint8Array(d.length / 4);
  for (let i = 0; i < cls.length; i++) {
    const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(d[i * 4 + k]! - ref[k]!)));
    cls[i] = diff <= 8 ? 0 : diff > 40 ? 1 : 2;
  }
  ((window as any).__frames ??= []).push(cls);
}, [png.toString("base64"), BACKGROUND] as const);

const pops = (page: Page) => page.evaluate(() => {
  const f: Uint8Array[] = (window as any).__frames;
  let n = 0, total = 0;
  for (let i = 1; i + 1 < f.length; i++) {
    const [a, b, c] = [f[i - 1]!, f[i]!, f[i + 1]!];
    for (let p = 0; p < b.length; p++) {
      total++;
      if ((b[p] === 0 && a[p] === 1 && c[p] === 1) || (b[p] === 1 && a[p] === 0 && c[p] === 0)) n++;
    }
  }
  // pixels more than 8 from BACKGROUND, in the frame that has most
  const off = Math.max(...f.map((x) => x.reduce((k, v) => k + (v === 0 ? 0 : 1), 0)));
  (window as any).__frames = [];
  return { pops: total ? n / total : 0, frames: f.length, off };
});

/** One camera change, then a render; returns once the frame is drawn. */
const step = (page: Page, change: string, v: number) => page.evaluate(async ([change, v]) => {
  const { map } = (window as any).__geoapp;
  if (change === "pan") map.panBy([0, -v], { animate: false });
  else if (change === "zoom") map.jumpTo({ zoom: map.getZoom() + v });
  else map.jumpTo({ pitch: map.getPitch() + v });
  await new Promise<void>((r) => { map.once("render", () => r()); map.triggerRepaint(); });
}, [change, v] as const);

test.describe("flicker probe (spec 045)", () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  /** Steps the probe's camera from where it is, screenshotting the band each frame. */
  async function walk(page: Page): Promise<void> {
    const box = (await page.locator("#map").boundingBox())!;
    const shot = async () => keep(page, await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: 60 } }));
    await shot();
    for (let i = 0; i < 60; i++) { await step(page, "pan", 2); await shot(); }
    for (let i = 0; i < 30; i++) { await step(page, "zoom", 0.5 / 30); await shot(); }
    for (let i = 0; i < 30; i++) { await step(page, "pitch", 15 / 30); await shot(); }
  }

  for (const run of RUNS) {
    test(`${run.name}: navy pops in the top band @probe`, async ({ page }) => {
      test.setTimeout(180_000);
      await openApp(page);
      await openRaster(page, rgbFixture());
      await expect(message(page)).toHaveText("Raster opened.");
      await page.evaluate(async ([centre, zoom, pitch]) => {
        const { map } = (window as any).__geoapp;
        map.jumpTo({ center: centre, zoom, pitch });
        await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
      }, [CENTRE, run.zoom, run.pitch] as const);
      await walk(page);
      const r = await pops(page);
      console.log(`flicker probe ${run.name}: pops ${(r.pops * 100).toFixed(3)}% over ${r.frames} frames (main ${MAIN[run.name]})`);
      test.info().annotations.push({ type: `probe ${run.name}`, description: JSON.stringify(r) });
      expect(r.frames).toBe(121);
      expect(r.pops).toBeLessThanOrEqual(0.0005);
    });
  }
});
