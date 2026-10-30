import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, message, openApp, openRaster, paintMode, rgbNodataFixture, rgbTiled, stroke, tileKeysStored, tiff, tiledTiff, toScreen, view } from "./helpers";
import { download, holdMasks, importFile, maskFile, noSavePicker } from "./seeding";

// Spec 019, tester: the approved decisions while the preview loads, replacement and refusal while loading, odd files.

const bar = (page: Page) => page.locator("#open-progress");
const paint = (page: Page) => page.locator("#mode-paint");
const pan = (page: Page) => page.locator("#mode-pan");
const otherFixture = () => tiledTiff("other.tif", 800, 600, 3, () => 150, { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });
const previewWest = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number | undefined);

/** Wrap reads of rasters `width` wide: held until release(), or failing (ProgressEvent) from read number `failFrom` on. */
async function gate(page: Page, width: number, opts: { hold?: boolean; failFrom?: number }): Promise<void> {
  await page.evaluate(([width, hold, failFrom]) => {
    const g = ((window as any).__g = { count: 0, held: [] as (() => void)[], hold, failFrom });
    (window as any).__geoapp.rasterFile = (src: any) => {
      if (src.meta.width !== width) return;
      // spec 020's preview reads blocks with readSamples; readWindow serves sources without it
      for (const m of ["readWindow", "readSamples"]) {
        const read = src[m]?.bind(src);
        if (!read) continue;
        src[m] = async (...a: unknown[]) => {
          g.count++;
          if (g.failFrom !== null && g.count >= g.failFrom) throw new ProgressEvent("error");
          if (g.hold) await new Promise<void>((r) => g.held.push(r));
          return read(...a);
        };
      }
    };
  }, [width, opts.hold ?? false, opts.failFrom ?? null] as const);
}
const held = (page: Page) => page.evaluate(() => (window as any).__g.held.length as number);
const release = (page: Page) => page.evaluate(() => { const g = (window as any).__g; g.hold = false; for (const go of g.held.splice(0)) go(); });
const failNow = (page: Page) => page.evaluate(() => { (window as any).__g.failFrom = 0; });

/** Open rgbFixture with its preview reads held. */
async function openHeld(page: Page): Promise<void> {
  await gate(page, 1000, { hold: true });
  await openRaster(page, rgbTiled());
  await expect.poll(() => held(page)).toBeGreaterThan(0);
  await expect(paint(page)).toBeDisabled();
}

test("while the preview loads: Space, middle-drag, wheel and WASD move the map; Opacity, Show labels, Add class and Export work; no Cancel", async ({ page }) => {
  await noSavePicker(page);
  await openApp(page);
  await openHeld(page);
  await jumpTo(page, [15, 45], 5);
  const box = (await page.locator("#map").boundingBox())!;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const moved = async (act: () => Promise<void>) => {
    const before = await view(page);
    await act();
    await page.waitForTimeout(400);
    expect(await view(page)).not.toEqual(before);
  };
  await moved(async () => { // Space + left drag
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(c.x + 80, c.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Space");
  });
  await moved(async () => { // middle drag
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(c.x - 80, c.y - 40, { steps: 8 });
    await page.mouse.up({ button: "middle" });
  });
  await moved(async () => { await page.mouse.wheel(0, -200); });
  await moved(async () => { await page.keyboard.down("d"); await page.waitForTimeout(300); await page.keyboard.up("d"); });

  await page.locator("#label-opacity").fill("30");
  await expect(page.locator("#label-opacity-text")).toHaveText("Opacity: 30%");
  await page.locator("#show-labels").uncheck();
  await page.locator("#show-labels").check();
  await expect(paint(page)).toBeDisabled();
  await expect(pan(page)).toHaveAttribute("aria-pressed", "true");
  const n = await page.locator("#classes li").count();
  await page.click("#class-add");
  await expect(page.locator("#classes li")).toHaveCount(n + 1);
  const file = await download(page, "#export-labels");
  expect(file.length).toBeGreaterThan(0);
  await expect(page.locator("#panel").getByRole("button", { name: /cancel/i })).toHaveCount(0);
  expect(await tileKeysStored(page)).toEqual([]);

  await release(page);
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(paint(page)).toBeEnabled();
  await expect(pan(page)).toHaveAttribute("aria-pressed", "true"); // Pan stays until the user picks Paint
  await expect(bar(page)).toBeHidden();
});

test("Import labels while the preview loads: it runs, selects Pan, and Paint enables once the preview shows", async ({ page }) => {
  await openApp(page);
  await openHeld(page);
  await expect(page.locator("#import-labels")).toBeEnabled();
  await importFile(page, maskFile());
  await release(page);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.labels.classes.length)).toBe(3);
  await expect(paint(page)).toBeEnabled();
  await expect(pan(page)).toHaveAttribute("aria-pressed", "true");
  await expect(bar(page)).toBeHidden();
  await expect(message(page)).not.toHaveText("");
});

test("replacing an open raster in Paint mode: the new one starts with Paint disabled, Pan pressed and a counted bar", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbTiled());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await gate(page, 800, { hold: true });
  await openRaster(page, otherFixture());
  await expect.poll(() => held(page)).toBeGreaterThan(0);
  await expect(paint(page)).toBeDisabled();
  await expect(pan(page)).toHaveAttribute("aria-pressed", "true");
  await expect(bar(page)).toBeVisible();
  await expect(message(page)).toHaveText(MESSAGES.buildingPreview);
  await release(page);
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(paint(page)).toBeEnabled();
  expect(await previewWest(page)).toBeCloseTo(30, 6);
});

test("a refused newer open leaves the older preview loading; it then opens with Paint enabled and the bar hidden", async ({ page }) => {
  await openApp(page);
  await openHeld(page);
  await openRaster(page, tiff("x4326.tif", 100, 100, 1, () => 1, { epsg: 4326, gt: [179.5, 0.01, 0, 10, 0, -0.01] }));
  await expect(message(page)).toHaveText(MESSAGES.rasterAntimeridian);
  await expect(bar(page)).toBeHidden();
  await expect(paint(page)).toBeDisabled();
  await release(page);
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(paint(page)).toBeEnabled();
  await expect(bar(page)).toBeHidden();
  expect(await previewWest(page)).toBeCloseTo(10, 6);
});

test("a file that isn't a TIFF shows a non-empty message and hides the bar", async ({ page }) => {
  await openApp(page);
  await openRaster(page, { name: "junk.tif", mimeType: "image/tiff", buffer: Buffer.from("not a tiff at all, just text") });
  await expect(message(page)).not.toHaveText("");
  await expect(message(page)).not.toHaveText(MESSAGES.buildingPreview);
  await expect(bar(page)).toBeHidden();
});

test("a single-window raster opens with the bar hidden and Paint enabled", async ({ page }) => {
  await openApp(page);
  await openRaster(page, tiff("tiny.tif", 100, 100, 3, () => 120, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }));
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(bar(page)).toBeHidden();
  await expect(paint(page)).toBeEnabled();
});

test("reads failing part-way through the preview: message, bar hidden, Paint disabled; the next file opens normally", async ({ page }) => {
  await openApp(page);
  await gate(page, 1000, { failFrom: 6 });
  await openRaster(page, rgbTiled());
  await expect(message(page)).toHaveText(MESSAGES.rasterUnreadable);
  await expect(bar(page)).toBeHidden();
  await expect(paint(page)).toBeDisabled();
  await openRaster(page, otherFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(paint(page)).toBeEnabled();
  await expect(bar(page)).toBeHidden();
});

test("a paint read that fails with a ProgressEvent shows rasterUnreadable (readErrorMessage)", async ({ page }) => {
  await openApp(page);
  await holdMasks(page); // the stroke, not the background, reads its masks (spec 023)
  await gate(page, 1000, {});
  await openRaster(page, rgbNodataFixture()); // rgbTiled holds no nodata, so a stroke reads nothing (spec 023 F2)
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await failNow(page);
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [15, 45]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await expect(message(page)).toHaveText(MESSAGES.rasterUnreadable);
});
