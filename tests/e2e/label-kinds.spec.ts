import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { measure, type Box } from "./layoutBoxes";

// Spec 062 criterion 4: grouping by label kind moves nothing. The fixture was recorded at 4a54545, before the change.
test.use({ viewport: { width: 1280, height: 720 } });

const BEFORE: Box[] = JSON.parse(readFileSync("tests/fixtures/layout-062.json", "utf8"));

test("after open, every element of the tool strip and panel sits where it did at 4a54545, and #kinds is hidden", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const now = new Map((await measure(page)).map((b) => [b.key, b]));
  for (const b of BEFORE) {
    const a = now.get(b.key);
    expect(a, b.key).toBeDefined();
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(a![k] - b[k]), `${b.key} ${k}`).toBeLessThanOrEqual(0.5);
  }
  await expect(page.locator("#kinds")).toBeAttached();
  await expect(page.locator("#kinds")).toBeHidden();
});
