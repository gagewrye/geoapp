import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { measure, type Box } from "./layoutBoxes";

// Spec 062 criterion 4: grouping by label kind moves nothing. The fixture was recorded at 4a54545, before the change.
test.use({ viewport: { width: 1280, height: 720 } });

/** Recorded on macOS (`platform`); Linux font metrics differ by 1 px (run 43339686870). */
const BEFORE: { platform: string; boxes: Box[] } = JSON.parse(readFileSync("tests/fixtures/layout-062.json", "utf8"));

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("after open, every element of the tool strip and panel sits where it did at 4a54545 @ci-skip", async ({ page }) => {
  await setup(page);
  const now = new Map((await measure(page)).map((b) => [b.key, b]));
  const off: string[] = [];
  for (const b of BEFORE.boxes) {
    const a = now.get(b.key);
    if (!a) { off.push(`${b.key} missing`); continue; }
    for (const k of ["x", "y", "width", "height"] as const) if (Math.abs(a[k] - b[k]) > 0.5) off.push(`${b.key} ${k}: ${b[k]} -> ${a[k]}`);
  }
  expect(off).toEqual([]);
});

test("after open, #kinds is hidden", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#kinds")).toBeAttached();
  await expect(page.locator("#kinds")).toBeHidden();
});
