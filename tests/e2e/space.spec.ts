import { expect, test, type Page } from "@playwright/test";
import { jumpTo, openApp, pixelAt, type Xy } from "./helpers";

// Spec 015: CSS stars behind the map canvas; in Mercator the opaque map hides them.

const SIDE = 120;

/** RGBA of a side x side page screenshot region with top-left `at`, decoded in the page. */
async function shot(page: Page, at: Xy, side = SIDE): Promise<Uint8ClampedArray> {
  const png = await page.screenshot({ clip: { x: at.x, y: at.y, width: side, height: side } });
  const data = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, img.width, img.height).data);
  }, png.toString("base64"));
  return new Uint8ClampedArray(data);
}

const meanChannel = (d: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
  return s / ((d.length / 4) * 3);
};
const brightPixels = (d: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i]! >= 160 && d[i + 1]! >= 160 && d[i + 2]! >= 160) n++;
  return n;
};

const mapBox = async (page: Page) => (await page.locator("#map").boundingBox())!;

test("stars: off the globe the bottom-left corner is dark with bright points; the globe's centre is not dark (criterion 2)", async ({ page }) => {
  await openApp(page);
  await jumpTo(page, [0, 20], 1.5);
  const box = await mapBox(page);
  const corner = await shot(page, { x: box.x, y: box.y + box.height - SIDE });
  expect(meanChannel(corner)).toBeLessThanOrEqual(30);
  expect(brightPixels(corner)).toBeGreaterThanOrEqual(3);
  const centre = await shot(page, { x: box.x + box.width / 2 - SIDE / 2, y: box.y + box.height / 2 - SIDE / 2 });
  expect(meanChannel(centre)).toBeGreaterThan(30);
});

for (const zoom of [12, 14]) {
  test(`Mercator at zoom ${zoom}: the map is opaque and the page shows its pixels, not stars (criterion 3)`, async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [10, 45], zoom);
    const box = await mapBox(page);
    const pts: Xy[] = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]
      .map(([fx, fy]) => ({ x: Math.round(box.x + box.width * fx!), y: Math.round(box.y + box.height * fy!) }));
    for (const p of pts) {
      const gl = await pixelAt(page, p);
      expect(gl[3], JSON.stringify(p)).toBe(255);
      const seen = Array.from((await shot(page, p, 1)).slice(0, 3));
      expect(seen.every((v, k) => Math.abs(v - gl[k]!) <= 2), `${JSON.stringify(p)}: page ${seen} vs canvas ${gl}`).toBe(true);
    }
  });
}
