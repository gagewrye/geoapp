import { expect, test } from "@playwright/test";
import { FEATURE, jumpTo, message, openApp, openRaster, pixelAt, rgbFixture, toScreen } from "./helpers";

// Tester addition: spec 001 criterion 12's globe check as written. Its latitude-limit polygon tests
// (criterion 15) were removed with polygon labelling (spec 003).

test("globe (criterion 12): at zoom 14 the known feature itself is drawn at its location", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, FEATURE, 14);
  const px = await pixelAt(page, await toScreen(page, FEATURE));
  expect(px.slice(0, 3).every((v) => v > 240), `feature pixel ${px}`).toBe(true); // white block
  await jumpTo(page, [FEATURE[0] + 0.2, FEATURE[1]], 14);
  const off = await pixelAt(page, await toScreen(page, [FEATURE[0] + 0.2, FEATURE[1]]));
  expect(off.slice(0, 3).every((v) => v > 240), `off-feature pixel ${off}`).toBe(false);
});
