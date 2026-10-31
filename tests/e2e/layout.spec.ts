import { expect, test, type Page } from "@playwright/test";
import { editName, jumpTo, message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 035 criteria 1-5, at 1280x720.
test.use({ viewport: { width: 1280, height: 720 } });

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const canvasWidth = async (page: Page) => (await box(page, "#map canvas")).width;
const bounds = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getBounds().toArray().flat() as number[]);
/** Keys are shortcuts only outside text fields. */
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("after open: a 40 px top bar, the tool strip left, the panel right, the status bar at the bottom, and the map between (criterion 1)", async ({ page }) => {
  await setup(page);
  const top = await box(page, "#topbar"), tools = await box(page, "#tools"), side = await box(page, "#side"), status = await box(page, "#status");
  expect([top.x, top.y, top.width, top.height]).toEqual([0, 0, 1280, 40]);
  expect([tools.x, tools.y, tools.width]).toEqual([0, 40, 56]);
  expect([side.x + side.width, side.y, side.width]).toEqual([1280, 40, 260]);
  expect(status.y + status.height).toBeCloseTo(720, 0);
  await expect.poll(async () => {
    const c = await box(page, "#map canvas");
    return Math.abs(c.width - (1280 - 56 - 260)) <= 2 && Math.abs(c.height - (720 - 40 - 28)) <= 2 && Math.abs(c.x - 56) <= 2 && Math.abs(c.y - 40) <= 2;
  }).toBe(true);
});

test("before open the side columns are hidden and the map is full width; after open the file actions are in the top bar and the modes in the strip (criterion 2)", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#tools")).toBeHidden();
  await expect(page.locator("#side")).toBeHidden();
  await expect(page.locator("#import-labels")).toBeHidden();
  expect(await canvasWidth(page)).toBeCloseTo(1280, 0);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#topbar #import-labels")).toBeVisible();
  await expect(page.locator("#topbar #export-labels")).toBeVisible();
  await expect(page.locator("#topbar #class-map")).toBeVisible();
  for (const m of ["pan", "paint", "erase"]) await expect(page.locator(`#tools #mode-${m}`)).toBeVisible();
  await expect(page.locator("#tools #mode-paint")).toHaveAttribute("title", "Paint (B)");
  await expect(page.locator("#tools #undo")).toBeVisible();
  await expect(page.locator("#brush-size")).toHaveText("7");
  await expect(page.locator("#label-opacity-text")).toHaveText("60%");
});

test("\\ collapses and restores the side columns, the state survives a reload, and in a class name \\ types (criterion 3)", async ({ page }) => {
  await setup(page);
  await unfocus(page);
  await page.keyboard.press("\\");
  await expect.poll(() => canvasWidth(page)).toBeCloseTo(1280, 0);
  await page.keyboard.press("\\");
  await expect.poll(() => canvasWidth(page)).toBeCloseTo(1280 - 56 - 260, 0);
  await page.keyboard.press("\\");
  await expect.poll(() => canvasWidth(page)).toBeCloseTo(1280, 0);

  await setup(page);
  await expect(page.locator("body")).toHaveClass(/\bcollapsed\b/);
  await expect.poll(() => canvasWidth(page)).toBeCloseTo(1280, 0);
  await unfocus(page);
  await page.keyboard.press("\\");
  await expect.poll(() => canvasWidth(page)).toBeCloseTo(1280 - 56 - 260, 0);
  const name = await editName(page, 0);
  await page.keyboard.press("End");
  await page.keyboard.press("\\");
  await expect(name).toHaveValue("Class 1\\");
  await expect(page.locator("body")).not.toHaveClass(/\bcollapsed\b/);
});

test("Home and the zoom-to-raster button fit the raster as opening did (criterion 4)", async ({ page }) => {
  await setup(page);
  const fitted = await bounds(page);
  const near = async () => (await bounds(page)).every((v, i) => Math.abs(v - fitted[i]!) <= 1e-6);
  await jumpTo(page, [40, 10], 9);
  expect(await near()).toBe(false);
  await unfocus(page);
  await page.keyboard.press("Home");
  await expect.poll(near).toBe(true);
  await jumpTo(page, [40, 10], 9);
  await page.locator(".maplibregl-ctrl button[aria-label='Zoom to raster']").click();
  await expect.poll(near).toBe(true);
});

test("with 60 classes the class list scrolls inside #side and the Labels section stays visible (criterion 5)", async ({ page }) => {
  await setup(page);
  for (let i = 2; i < 60; i++) await page.click("#class-add");
  await expect(page.locator("#classes li")).toHaveCount(60);
  expect(await page.locator("#classes").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const side = await box(page, "#side"), list = await box(page, "#classes");
  expect(list.y + list.height).toBeLessThanOrEqual(side.y + side.height + 0.5);
  for (const sel of ["#show-labels", "#label-opacity"]) {
    await expect(page.locator(sel)).toBeInViewport();
    const b = await box(page, sel);
    expect(b.y + b.height).toBeLessThanOrEqual(side.y + side.height + 0.5);
  }
});
