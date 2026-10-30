import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, message, openApp, openRaster, paintMode, rgbTiled, stroke, tileKeysStored, tiff, tiledTiff, toScreen } from "./helpers";

// Spec 019: the open progress bar, no Paint before the preview shows, and messages for errors without one.

/** 800 x 600, 3 bands, at 30..38E, 40..46N: a different size and place from rgbFixture. */
const otherFixture = () => tiledTiff("other.tif", 800, 600, 3, (b, c) => (b === 0 ? (c < 400 ? 200 : 120) : 150),
  { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });
const bar = (page: Page) => page.locator("#open-progress");
const paint = (page: Page) => page.locator("#mode-paint");
const previewWest = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number | undefined);

type Snap = { hidden: boolean; value: number | null; message: string };

/** Records the bar's state, with #message, at every change of either. */
async function recordBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = document.getElementById("open-progress")!, m = document.getElementById("message")!;
    const snaps: Snap[] = ((window as any).__bar = []);
    const snap = () => snaps.push({ hidden: p.hidden === true, value: p.hasAttribute("value") ? Number(p.getAttribute("value")) : null, message: m.textContent ?? "" });
    const o = new MutationObserver(snap);
    o.observe(p, { attributes: true });
    o.observe(m, { childList: true, characterData: true, subtree: true });
  });
}
const snaps = (page: Page) => page.evaluate(() => (window as any).__bar as Snap[]);

/**
 * Through the app's rasterFile hook, wrap the reads of rasters `width` wide: "hold" queues them until
 * release(), "fail" rejects them with a ProgressEvent as a failed FileReader does. Counts their reads.
 */
async function gateReads(page: Page, width: number, mode: "hold" | "fail"): Promise<void> {
  await page.evaluate(([width, mode]) => {
    const g = ((window as any).__reads = { count: 0, held: [] as (() => void)[], hold: mode === "hold" });
    (window as any).__geoapp.rasterFile = (src: any) => {
      if (src.meta.width !== width) return;
      // spec 020's preview reads blocks with readSamples; readWindow serves sources without it
      for (const m of ["readWindow", "readSamples"]) {
        const read = src[m]?.bind(src);
        if (!read) continue;
        src[m] = async (...a: unknown[]) => {
          g.count++;
          if (mode === "fail") throw new ProgressEvent("error");
          if (g.hold) await new Promise<void>((r) => g.held.push(r));
          return read(...a);
        };
      }
    };
  }, [width, mode] as const);
}
const reads = (page: Page) => page.evaluate(() => (window as any).__reads as { count: number; held: unknown[] });
const release = (page: Page) => page.evaluate(() => {
  const g = (window as any).__reads;
  g.hold = false;
  for (const go of g.held.splice(0)) go();
});

test.describe("progress while a raster opens", () => {
  test("the bar shows a value before Raster opened., and is hidden after (criterion 4)", async ({ page }) => {
    await openApp(page);
    await expect(bar(page)).toBeHidden();
    await recordBar(page);
    await openRaster(page, rgbTiled());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(bar(page)).toBeHidden();
    const s = await snaps(page);
    const done = s.findIndex((x) => x.message === "Raster opened.");
    const before = s.slice(0, done);
    expect(before.some((x) => !x.hidden && x.value !== null && x.value > 0)).toBe(true);
    expect(before.some((x) => x.message === MESSAGES.buildingPreview)).toBe(true);
    expect(before.some((x) => x.message === MESSAGES.drawingPreview && !x.hidden && x.value === null)).toBe(true);
    expect(s.at(-1)!.hidden).toBe(true);
  });

  test("a second open stops the first one's reads and shows its own preview (criterion 5)", async ({ page }) => {
    await openApp(page);
    await gateReads(page, 1000, "hold");
    await openRaster(page, { ...rgbTiled(), name: "slow.tif" });
    await expect.poll(async () => (await reads(page)).held.length).toBeGreaterThan(0);
    await expect(bar(page)).toBeVisible();
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    const count = (await reads(page)).count;
    await release(page);
    await page.waitForTimeout(800);
    expect((await reads(page)).count).toBe(count); // no read after the held one
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(bar(page)).toBeHidden();
  });

  test("a refused raster shows its message and hides the bar (criterion 6)", async ({ page }) => {
    await openApp(page);
    await recordBar(page);
    await openRaster(page, tiff("x4326.tif", 100, 100, 1, () => 1, { epsg: 4326, gt: [179.5, 0.01, 0, 10, 0, -0.01] }));
    await expect(message(page)).toHaveText(MESSAGES.rasterAntimeridian);
    await expect(bar(page)).toBeHidden();
    expect((await snaps(page)).some((x) => !x.hidden)).toBe(true); // it showed while the header was read
  });

  test("Cancel at the discard prompt hides the bar and keeps the raster, labels and Paint (criterion 7)", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbTiled());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await jumpTo(page, [15, 45], 6);
    const a = await toScreen(page, [12.005, 45.005]);
    await stroke(page, [a, { x: a.x + 40, y: a.y }]);
    const keys = await tileKeysStored(page);
    expect(keys.length).toBeGreaterThan(0);
    await recordBar(page);
    const asked: string[] = [];
    page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
    await openRaster(page, otherFixture());
    await expect.poll(() => asked).toEqual([MESSAGES.discard]);
    await expect(bar(page)).toBeHidden();
    expect((await snaps(page)).some((x) => !x.hidden)).toBe(true);
    await expect(page.locator("#raster-info")).toHaveText(/^rgb4326\.tif: 1000 x 1000/);
    expect(await tileKeysStored(page)).toEqual(keys);
    await expect(paint(page)).toBeEnabled();
    await expect(paint(page)).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("no painting before the imagery shows", () => {
  test("Paint is disabled until the preview is drawn; class keys and [ ] still work (criterion 8)", async ({ page }) => {
    await openApp(page);
    await gateReads(page, 1000, "hold");
    await openRaster(page, rgbTiled());
    await expect.poll(async () => (await reads(page)).held.length).toBeGreaterThan(0);
    await expect(paint(page)).toBeDisabled();
    await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
    await jumpTo(page, [15, 45], 6);
    const a = await toScreen(page, [15, 45]);
    await stroke(page, [a, { x: a.x + 60, y: a.y + 20 }]);
    expect(await tileKeysStored(page)).toEqual([]);
    await page.keyboard.press("2");
    await expect(page.locator("#classes li").nth(1)).toHaveClass(/selected/);
    const size = await page.locator("#brush-size").textContent();
    await page.keyboard.press("]");
    await expect(page.locator("#brush-size")).not.toHaveText(size!);
    await expect(message(page)).not.toHaveText("Raster opened.");
    await release(page);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(paint(page)).toBeEnabled();
    expect(await tileKeysStored(page)).toEqual([]);
  });

  test("when the preview's reads fail, a message shows and Paint stays disabled (criterion 9)", async ({ page }) => {
    await openApp(page);
    await gateReads(page, 1000, "fail");
    await openRaster(page, rgbTiled());
    await expect(message(page)).toHaveText(MESSAGES.rasterUnreadable);
    await expect(paint(page)).toBeDisabled();
    await expect(bar(page)).toBeHidden();
    await page.waitForTimeout(300);
    await expect(paint(page)).toBeDisabled();
  });
});
