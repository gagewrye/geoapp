import { expect, test } from "@playwright/test";
import { tiledGeotiffBuffer } from "../unit/helpers/tiledTiff";
import { jumpTo, mapIdle, message, openApp, openRaster, overlaysIdle, paintMode, rgbFixture, stroke, toScreen } from "./helpers";

// TEMPORARY (spec 072 step 0): times openApp, the open, jumpTo at zoom 7 and one stroke for three fixtures; reverted before merge.
const value = (px: number) => (b: number, c: number, r: number) => {
  const lon = 10 + (c + 0.5) * px, lat = 50 - (r + 0.5) * px;
  if (Math.abs(lon - 15.5) < 0.05 && Math.abs(lat - 45.5) < 0.05) return 255;
  return b === 0 ? (lon < 15 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150;
};
const tiled = (name: string, side: number) => ({ name, mimeType: "image/tiff",
  buffer: Buffer.from(tiledGeotiffBuffer(side, side, 3, value(10 / side), { epsg: 4326, gt: [10, 10 / side, 0, 50, 0, -10 / side] })) });
const FIXTURES = { strip1000: rgbFixture, tiled1000: () => tiled("rgbtiled.tif", 1000), tiled512: () => tiled("rgb512.tif", 512) };

test.describe.configure({ mode: "parallel" });
for (const [name, make] of Object.entries(FIXTURES)) for (const rep of [1, 2]) {
  test(`step 0 timing ${name} #${rep}`, async ({ page }) => {
    const t: Record<string, number> = {};
    let at = Date.now();
    const lap = (k: string) => { const now = Date.now(); t[k] = now - at; at = now; };
    const file = make();
    lap("fixture");
    await openApp(page);
    lap("openApp");
    await openRaster(page, file);
    await expect(message(page)).toHaveText("Raster opened.", { timeout: 60_000 });
    lap("open");
    await jumpTo(page, [15, 45], 7);
    await overlaysIdle(page);
    await mapIdle(page);
    lap("jumpTo7");
    await paintMode(page);
    const a = await toScreen(page, [12.005, 45.005]);
    await stroke(page, [a, { x: a.x + 60, y: a.y + 20 }, { x: a.x + 120, y: a.y }]);
    lap("stroke");
    test.info().annotations.push({ type: "timing", description: JSON.stringify(t) });
  });
}
