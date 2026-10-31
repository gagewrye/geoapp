import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture } from "./helpers";

// Tester checks of spec 015: no text sits on the starfield without its own background, and stars show
// above a pitched Mercator horizon (Rules: Where stars show).

/** Visible elements with text or a control role whose box overlaps #map and whose painted background is transparent up to #map. */
const textOnStars = (page: Page) => page.evaluate(() => {
  const map = document.getElementById("map")!;
  const mb = map.getBoundingClientRect();
  const opaque = (el: Element | null): boolean => {
    for (let e = el; e && e !== map; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      const a = bg.startsWith("rgba") ? Number(bg.slice(bg.lastIndexOf(",") + 1, -1)) : bg === "transparent" ? 0 : 1;
      if (a >= 0.8 || getComputedStyle(e).backgroundImage !== "none") return true;
    }
    return false;
  };
  const out: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
    if (r.right <= mb.left || r.left >= mb.right || r.bottom <= mb.top || r.top >= mb.bottom) continue;
    if (el === map || el.closest("canvas") || el.tagName === "CANVAS") continue;
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) || el.matches("button, input, select, a, [role]");
    if (text && !opaque(el)) out.push(`${el.tagName}#${el.id}.${el.className}: ${(el.textContent ?? "").trim().slice(0, 30)}`);
  }
  return out;
});

test("no text or control over the map sits on the stars without its own background", async ({ page }) => {
  await openApp(page);
  await jumpTo(page, [0, 20], 1.5);
  expect(await textOnStars(page)).toEqual([]);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 2);
  expect(await textOnStars(page)).toEqual([]);
  // the tool strip and the panel stay beside the map (left and right: spec 035), on the page's own background
  const tools = (await page.locator("#tools").boundingBox())!, panel = (await page.locator("#panel").boundingBox())!, map = (await page.locator("#map").boundingBox())!;
  expect(tools.x + tools.width).toBeLessThanOrEqual(map.x + 1);
  expect(panel.x).toBeGreaterThanOrEqual(map.x + map.width - 1);
  await page.screenshot({ path: test.info().outputPath("globe-with-panel.png") });
});

test("above a pitched Mercator horizon the canvas is transparent and the dark starfield shows", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const { map } = (window as any).__geoapp;
    map.setMaxPitch(85);
    map.jumpTo({ center: [10, 45], zoom: 13, pitch: 85 });
    await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
  });
  const box = (await page.locator("#map").boundingBox())!;
  const png = await page.screenshot({ clip: { x: box.x + 10, y: box.y + 5, width: box.width - 20, height: 20 } });
  const mean = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
    return s / ((d.length / 4) * 3);
  }, png.toString("base64"));
  expect(mean).toBeLessThanOrEqual(30);
});
