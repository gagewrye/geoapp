import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture, toScreen, type Xy } from "./helpers";

// Spec 064 criteria 6 and 7: draw, edit and undo a box on rgbFixture (1000 x 1000 px of 0.01 degrees from 10E 50N).
type Box = { id: number; value: number; x0: number; y0: number; x1: number; y1: number };
const boxes = (page: Page): Promise<Box[]> => page.evaluate(() => (window as any).__geoapp.boxes());
/** The screen point of pixel edge (x, y); x + 0.5 is a pixel's centre. */
const edge = (page: Page, x: number, y: number) => toScreen(page, [10 + x * 0.01, 50 - y * 0.01]);
const centre = (page: Page, c: number, r: number) => edge(page, c + 0.5, r + 0.5);
async function drag(page: Page, a: Xy, b: Xy): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}
const rect = async (page: Page) => { const [b] = await boxes(page); return b && { value: b.value, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }; };
const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");

test("R and a drag draw a box that renders and undoes; a move, an se resize, class 2 and Delete each undo in one step", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [10.25, 49.8], 9);
  await page.keyboard.press("r");
  await expect(page.locator("#mode-box")).toHaveAttribute("aria-pressed", "true");
  await drag(page, await centre(page, 10, 10), await centre(page, 40, 30));
  const drawn = { value: 1, x0: 10, y0: 10, x1: 41, y1: 31 };
  expect(await rect(page)).toEqual(drawn);
  await expect(page.locator("#status-tool")).toHaveText("Box · Class 1 · 31×21 px");
  // criterion 6: the ring renders at the box's west edge
  const west = await edge(page, 10, 20);
  await expect.poll(() => page.evaluate(({ x, y }) => {
    const { map } = (window as any).__geoapp, r = map.getCanvas().getBoundingClientRect();
    return map.queryRenderedFeatures([[x - r.left - 3, y - r.top - 3], [x - r.left + 3, y - r.top + 3]], { layers: ["boxes-line"] }).length;
  }, west)).toBeGreaterThan(0);
  await undo(page);
  expect(await boxes(page)).toEqual([]);
  await page.keyboard.press("Control+y");
  expect(await rect(page)).toEqual(drawn);

  // criterion 7: each edit, then one Ctrl+Z
  const inside = await centre(page, 25, 20);
  await page.mouse.click(inside.x, inside.y); // a redo doesn't select; a click does
  const edits: [() => Promise<void>, Partial<Box>][] = [
    [async () => drag(page, inside, await centre(page, 30, 25)), { x0: 15, y0: 15, x1: 46, y1: 36 }],
    [async () => drag(page, await edge(page, 41, 31), await centre(page, 50, 40)), { x1: 51, y1: 41 }],
    [() => page.keyboard.press("2"), { value: 2 }],
  ];
  for (const [act, want] of edits) {
    await act();
    expect(await rect(page)).toEqual({ ...drawn, ...want });
    await undo(page);
    expect(await rect(page)).toEqual(drawn);
  }
  await page.keyboard.press("Delete");
  expect(await boxes(page)).toEqual([]);
  await undo(page);
  expect(await rect(page)).toEqual(drawn);
});
