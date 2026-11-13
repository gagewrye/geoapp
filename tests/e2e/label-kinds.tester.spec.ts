import { expect, test } from "@playwright/test";
import { message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 062 edge cases (tester): hidden kind wrappers really leave the layout despite .tool-group's display,
// the Tab order of #tools is unchanged, and the wrapped mode buttons still select their modes.
test.use({ viewport: { width: 1280, height: 720 } });

async function open(page: import("@playwright/test").Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("a hidden kind group or section is display:none, so a second kind's switch can really hide Masks", async ({ page }) => {
  await open(page);
  for (const id of ["tools-mask", "brush-group", "mask-view"]) {
    await page.evaluate((i) => { document.getElementById(i)!.hidden = true; }, id);
    expect(await page.evaluate((i) => getComputedStyle(document.getElementById(i)!).display, id), id).toBe("none");
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.locator("#mode-pan")).toBeVisible();
  await expect(page.locator("#mode-smart")).toBeVisible();
});

test("#kinds is empty but for the one Masks radio, unfocusable, and the strip's focus order is unchanged", async ({ page }) => {
  await open(page);
  await expect(page.locator("#kinds > *")).toHaveCount(1);
  await expect(page.locator("#kind-mask")).toHaveAttribute("role", "radio");
  await expect(page.locator("#kind-mask")).toHaveAttribute("aria-checked", "true");
  const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#tools button, #tools input")]
    .filter((e) => e.offsetParent !== null && !(e as HTMLButtonElement).disabled && e.tabIndex >= 0).map((e) => e.id));
  expect(order).toEqual(["mode-pan", "mode-paint", "mode-erase", "mode-fill", "mode-polygon", "mode-smart", "brush-larger", "brush-smaller", "brush-size-range"]);
});

test("the wrapped mode buttons and keys still select their modes, and no Masks group is ever hidden", async ({ page }) => {
  await open(page);
  for (const m of ["paint", "erase", "fill", "polygon", "pan"]) {
    await page.locator(`#mode-${m}`).click();
    await expect(page.locator(`#mode-${m}`)).toHaveAttribute("aria-pressed", "true");
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const [k, m] of [["b", "paint"], ["e", "erase"], ["f", "fill"], ["l", "polygon"], ["p", "pan"]]) {
    await page.keyboard.press(k!);
    await expect(page.locator(`#mode-${m}`)).toHaveAttribute("aria-pressed", "true");
  }
  for (const id of ["tools-mask", "brush-group", "mask-view"]) await expect(page.locator(`#${id}`)).toBeVisible();
});
