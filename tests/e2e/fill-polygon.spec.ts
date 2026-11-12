import { expect, test, type Page } from "@playwright/test";
import { polygonSpans } from "../../src/core/polygon";
import { MESSAGES } from "../../src/ui/messages";
import { hintOf, jumpTo, labels, message, openApp, openRaster, rgbFixture, settled, toScreen, view } from "./helpers";
import { at, importFile, inNodata, maskFile, maskValue, ND_GRID, nodataImagery } from "./seeding";

// Spec 054 criteria 10-13. Undo and Redo go through their buttons, whose key differs by platform (spec 045).
const tool = (page: Page) => page.locator("#status-tool");
const pressed = (page: Page, mode: string) => expect(page.locator(`#mode-${mode}`)).toHaveAttribute("aria-pressed", "true");
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** The polygon outline's features by kind, such as { corner: 2, first: 1, line: 1, area: 1 }. */
const outline = (page: Page): Promise<Record<string, number>> => page.evaluate(async () => {
  const s = (window as any).__geoapp.map.getSource("polygon");
  const out: Record<string, number> = {};
  for (const f of s ? ((await s.getData()) as any).features : []) out[f.properties.kind] = (out[f.properties.kind] ?? 0) + 1;
  return out;
});
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

test("Fill gives the clicked region of an imported mask the selected class, one Undo restores it, and Redo fills again (criterion 10)", async ({ page }) => {
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

test("Fill stops at imagery nodata, and a click on nodata fills nothing (criterion 11)", async ({ page }) => {
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

test("Polygon: clicks add corners, Enter fills the outline except nodata as one undoable edit, and a double click closes without zooming (criterion 12)", async ({ page }) => {
  await open(page, nodataImagery(), [430, 425]);
  await page.keyboard.press("l");
  await pressed(page, "polygon");
  await expect(tool(page)).toHaveText("Polygon · Class 1");
  const corners: [number, number][] = [[390, 395], [470, 400], [465, 455], [395, 450]];
  for (const [c, r] of corners) await clickCell(page, c, r);
  expect(await outline(page)).toMatchObject({ first: 1, corner: 3, area: 1 });
  await page.keyboard.press("Enter");
  await settled(page);
  await expect.poll(() => outline(page)).toEqual({});
  const want = new Set<string>();
  for (const s of polygonSpans(corners, ND_GRID)) for (let c = s.x0; c < s.x1; c++) if (!inNodata(c, s.row)) want.add(`${c},${s.row}`);
  let got = await labels(page);
  expect(new Set(got.keys())).toEqual(want);
  expect(new Set(got.values())).toEqual(new Set([1]));
  await page.click("#undo");
  expect((await labels(page)).size).toBe(0);

  // right click and Backspace each remove the last corner; a double click on the last corner closes, and the map doesn't zoom
  const tri: [number, number][] = [[461, 402], [468, 402], [464, 412]]; // right of the nodata block, clear of the zoom buttons
  for (const [c, r] of [...tri, [468, 425] as [number, number]]) await clickCell(page, c, r);
  await clickCell(page, 463, 432, "right");
  expect(await outline(page)).toMatchObject({ first: 1, corner: 2 });
  await page.keyboard.press("Backspace");
  expect(await outline(page)).toMatchObject({ first: 1, corner: 1 });
  const before = await view(page);
  const last = await toScreen(page, at(464.5, 412.5));
  await page.mouse.dblclick(last.x, last.y);
  await settled(page);
  await expect.poll(() => outline(page)).toEqual({});
  expect((await view(page)).zoom).toBe(before.zoom);
  got = await labels(page);
  const triangle = new Set<string>();
  for (const s of polygonSpans(tri, ND_GRID)) for (let c = s.x0; c < s.x1; c++) triangle.add(`${c},${s.row}`);
  expect(new Set(got.keys())).toEqual(triangle);
});

test("F and L select the tools, Escape discards an outline before it selects Pan, and the help lists both (criterion 13)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  for (const m of ["fill", "polygon"]) await expect(page.locator(`#mode-${m}`)).toBeDisabled(); // as Paint, until the imagery is drawn
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(408, 408), 9);
  await unfocus(page);
  await expect(page.locator("#mode-fill")).toHaveAttribute("title", `Fill (F)\n${hintOf("fill")}`);
  await expect(page.locator("#mode-polygon")).toHaveAttribute("title", `Polygon (L)\n${hintOf("polygon")}`);
  await page.keyboard.press("f");
  await pressed(page, "fill");
  await page.keyboard.press("l");
  await pressed(page, "polygon");
  await clickCell(page, 400, 400);
  await clickCell(page, 420, 400);
  await page.keyboard.press("Escape");
  await pressed(page, "polygon");
  expect(await outline(page)).toEqual({});
  await page.keyboard.press("Escape");
  await pressed(page, "pan");
  // leaving the tool drops an outline, and hidden labels show again when a tool is chosen
  await page.keyboard.press("l");
  await clickCell(page, 400, 400);
  await page.keyboard.press("b");
  expect(await outline(page)).toEqual({});
  await page.keyboard.press("h");
  await pressed(page, "pan");
  await page.keyboard.press("f");
  await expect(page.locator("#show-labels")).toBeChecked();
  await page.keyboard.press("?");
  const rows = page.locator("#help-list tr.shortcut");
  await expect(rows.filter({ hasText: "Fill the polygon" })).toContainText("Enter / Double click");
  await expect(rows.filter({ hasText: "Remove the last corner" })).toContainText("Backspace / Right click");
  await expect(rows.filter({ hasText: /^F\s*Fill$/ })).toHaveCount(1);
});
