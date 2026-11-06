import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, message, openApp, openRaster, rgbFixture, settled, toScreen } from "./helpers";
import { at, importFile, inNodata, maskFile, maskValue, nodataImagery } from "./seeding";

// Spec 054 criteria 9-11. Undo and Redo go through their buttons, whose key differs by platform (spec 045).
const tool = (page: Page) => page.locator("#status-tool");
const pressed = (page: Page, mode: string) => expect(page.locator(`#mode-${mode}`)).toHaveAttribute("aria-pressed", "true");
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** Clicks the centre of raster cell (c, r). */
async function clickCell(page: Page, c: number, r: number, button: "left" | "right" = "left") {
  const p = await toScreen(page, at(c + 0.5, r + 0.5));
  await page.mouse.click(p.x, p.y, { button });
}

async function open(page: Page, file: ReturnType<typeof rgbFixture>, centre: [number, number]) {
  await openApp(page);
  await openRaster(page, file);
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(...centre), 9); // about 7 screen px per pixel
  await unfocus(page);
}

test("Fill gives the clicked region of an imported mask the selected class, one Undo restores it, and Redo fills again (criterion 9)", async ({ page }) => {
  await open(page, rgbFixture(), [408, 408]);
  await importFile(page, maskFile());
  await expect(message(page)).toContainText("Seeded");
  await page.keyboard.press("f");
  await pressed(page, "fill");
  await page.keyboard.press("3");
  await expect(tool(page)).toHaveText("Fill · Class 3");
  // the 16 x 16 block at 400..415 holds value 2, and touches its like only at corners
  expect(maskValue(408, 408)).toBe(2);
  await clickCell(page, 408, 408);
  await expect(message(page)).toHaveText(MESSAGES.filled(256));
  let got = await labels(page);
  for (let r = 380; r < 440; r++) for (let c = 380; c < 440; c++) {
    const inBlock = c >= 400 && c < 416 && r >= 400 && r < 416;
    expect(got.get(`${c},${r}`) ?? 0, `${c},${r}`).toBe(inBlock ? 3 : maskValue(c, r));
  }
  // an unlabelled block fills too, and a click on the class it now has changes nothing
  expect(maskValue(408, 440)).toBe(0);
  await clickCell(page, 408, 440);
  await expect(message(page)).toHaveText(MESSAGES.filled(256));
  await clickCell(page, 408, 440);
  await expect(message(page)).toHaveText(MESSAGES.fillSame);
  await page.click("#undo");
  await page.click("#undo");
  await expect(page.locator("#undo")).toBeDisabled();
  got = await labels(page);
  expect([got.get("408,408"), got.get("408,440")]).toEqual([2, undefined]);
  await page.click("#redo");
  expect((await labels(page)).get("408,408")).toBe(3);
});

test("Fill stops at imagery nodata, and a click on nodata fills nothing (criterion 10)", async ({ page }) => {
  await open(page, nodataImagery(), [430, 425]);
  await page.click("#mode-fill");
  await clickCell(page, 395, 425); // just left of the nodata block
  await expect(message(page)).toHaveText(MESSAGES.filled(1000 * 1000 - 60 * 50));
  await settled(page);
  const got = await labels(page);
  expect(got.size).toBe(1000 * 1000 - 60 * 50);
  for (const k of got.keys()) { const [c, r] = k.split(",").map(Number) as [number, number]; if (inNodata(c, r)) throw new Error(`nodata pixel ${k} was filled`); }
  await page.click("#undo");
  expect((await labels(page)).size).toBe(0);
  await clickCell(page, 430, 425);
  await expect(message(page)).toHaveText(MESSAGES.fillNodata);
  expect((await labels(page)).size).toBe(0);
  await expect(page.locator("#undo")).toBeDisabled();
});

test("F selects Fill, which is offered when Paint is, shows hidden labels, and the help lists it (criterion 11)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(page.locator("#mode-fill")).toBeDisabled(); // as Paint, until the imagery is drawn
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(408, 408), 9);
  await unfocus(page);
  await expect(page.locator("#mode-fill")).toBeEnabled();
  await expect(page.locator("#mode-fill")).toHaveAttribute("title", "Fill (F)");
  await page.keyboard.press("f");
  await pressed(page, "fill");
  await expect(tool(page)).toHaveText("Fill · Class 1");
  await page.keyboard.press("Escape");
  await pressed(page, "pan");
  await page.keyboard.press("h");
  await expect(page.locator("#show-labels")).not.toBeChecked();
  await page.keyboard.press("f");
  await pressed(page, "fill");
  await expect(page.locator("#show-labels")).toBeChecked();
  await page.keyboard.press("h"); // hiding them selects Pan (spec 016)
  await pressed(page, "pan");
  await page.keyboard.press("?");
  const rows = page.locator("#help-list tr.shortcut");
  await expect(rows.filter({ hasText: /^F\s*Fill$/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Fill the area under the pointer" })).toContainText("Click");
});
