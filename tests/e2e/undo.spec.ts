import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, openApp, openRaster, paintTwoClasses, rgbFixture, selectClass, settled, stroke, toScreen, type Xy } from "./helpers";

// Spec 010: undo of paint and erase strokes (button and Ctrl+Z), and the brush cursor.
const undoButton = (page: Page) => page.locator("#undo");
const snapshot = async (page: Page) => [...(await labels(page))].sort();

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
}

/** Each stored tile has an overlay whose opaque colours are exactly its classes' colours; no other overlay exists. */
const overlaysMatch = (page: Page) => page.evaluate(() => {
  const { map, labels: { store, classes } } = (window as any).__geoapp;
  const ids = map.getStyle().layers.map((l: any) => l.id as string).filter((id: string) => id.startsWith("label-")).sort();
  const keys = [...store.tiles.keys()].map((k) => `label-${k}`).sort();
  if (JSON.stringify(ids) !== JSON.stringify(keys)) return `layers ${ids} vs tiles ${keys}`;
  for (const [key, tile] of store.tiles as Map<string, Uint8Array>) {
    const want = new Set([...new Set(tile)].filter((v) => v).map((v) => classes[v - 1].colour.toLowerCase()));
    const canvas: HTMLCanvasElement = map.getSource(`label-${key}`).canvas;
    const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const got = new Set<string>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (d[i + 3] !== 255) return `alpha ${d[i + 3]}`;
      got.add(`#${[d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    }
    if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) return `tile ${key}: ${[...got]} vs ${[...want]}`;
  }
  return "ok";
});

/** Strokes A (class 1), B (class 2 over part of A) and C (erasing class 2 over part of B); snapshots before each. */
async function threeStrokes(page: Page) {
  const c = await toScreen(page, [15.005, 45.005]);
  const line = (dy: number, x0: number, x1: number): Xy[] => [{ x: c.x + x0, y: c.y + dy }, { x: c.x + (x0 + x1) / 2, y: c.y + dy + 5 }, { x: c.x + x1, y: c.y + dy }];
  const before: [string, number][][] = [];
  before.push(await snapshot(page));
  await selectClass(page, 0);
  await stroke(page, line(0, 0, 120));
  before.push(await snapshot(page));
  await selectClass(page, 1);
  await stroke(page, [{ x: c.x + 60, y: c.y - 20 }, { x: c.x + 70, y: c.y }, { x: c.x + 80, y: c.y + 20 }]);
  before.push(await snapshot(page));
  await stroke(page, [{ x: c.x + 80, y: c.y + 20 }, { x: c.x + 70, y: c.y + 5 }], "right");
  for (const s of before.slice(1)) expect(s.length).toBeGreaterThan(0);
  expect(await snapshot(page)).not.toEqual(before[2]);
  return before;
}

for (const how of ["button", "Ctrl+Z"] as const) {
  test(`three undos by ${how} restore the store before each stroke, overlays follow, then Undo is disabled (criterion 3)`, async ({ page }) => {
    await setup(page);
    await expect(undoButton(page)).toBeDisabled();
    const before = await threeStrokes(page);
    await expect(undoButton(page)).toBeEnabled();
    for (let i = 2; i >= 0; i--) {
      if (how === "button") await undoButton(page).click();
      else { await page.locator("#map canvas").focus(); await page.keyboard.press("Control+z"); }
      expect(await snapshot(page)).toEqual(before[i]);
      await expect.poll(() => overlaysMatch(page)).toBe("ok");
    }
    await expect(undoButton(page)).toBeDisabled();
  });
}

test("Ctrl+Z in a class name field undoes the typing, not a stroke (criterion 3)", async ({ page }) => {
  await setup(page);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  const painted = await snapshot(page);
  const field = page.locator("#classes .class-name").first();
  await field.click();
  await field.press("End");
  await page.keyboard.type("xy");
  await expect(field).toHaveValue("Class 1xy");
  await page.keyboard.press("Control+z");
  await expect(field).not.toHaveValue("Class 1xy");
  expect(await snapshot(page)).toEqual(painted);
  await expect(undoButton(page)).toBeEnabled();
});

test("Undo is disabled while a stroke's cells wait for masks; then one Undo removes the whole stroke (criterion 4)", async ({ page }) => {
  await setup(page);
  const empty = await snapshot(page);
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const read = s.readWindow.bind(s);
    const g = (window as any).__gate = { held: true, open: null as null | (() => void), wait: null as null | Promise<void> };
    g.wait = new Promise<void>((r) => { g.open = r; });
    s.readWindow = async (...a: unknown[]) => { if (g.held) await g.wait; return read(...a); };
  });
  const c = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y);
  await expect(undoButton(page)).toBeDisabled(); // during the stroke
  await page.mouse.move(c.x + 300, c.y + 200); // into more tiles
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(undoButton(page)).toBeDisabled(); // after it, cells still waiting
  expect((await labels(page)).size).toBe(0);
  await page.evaluate(() => { const g = (window as any).__gate; g.held = false; g.open(); });
  await settled(page);
  expect((await labels(page)).size).toBeGreaterThan(0);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual(empty);
  await expect(undoButton(page)).toBeDisabled();
});

test("opening another raster clears the history; Train keeps it (criterion 5)", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const painted = await snapshot(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on /);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click(); // the class 2 stroke
  const one = await snapshot(page);
  expect(one.length).toBeLessThan(painted.length);
  expect(one.every(([, v]) => v === 1)).toBe(true);
  await expect(undoButton(page)).toBeEnabled(); // the class 1 stroke is still there
  page.on("dialog", (d) => void d.accept());
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(undoButton(page)).toBeDisabled();
  await page.keyboard.press("Control+z");
  expect(await snapshot(page)).toEqual([]);
});

const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const classColour = (page: Page, i: number) => page.evaluate((i) => (window as any).__geoapp.labels.classes[i].colour as string, i);
function expectBrush(cursor: string, colour: string) {
  expect(cursor.startsWith('url("data:image/svg+xml')).toBe(true);
  expect(decodeURIComponent(cursor).toLowerCase()).toContain(colour.toLowerCase());
  expect(cursor.endsWith("crosshair")).toBe(true);
}

test("the brush cursor shows the selected colour in Paint mode only (criterion 7)", async ({ page }) => {
  await openApp(page);
  const box = (await page.locator("#map canvas").boundingBox())!;
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false); // no imagery
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.mouse.move(p.x, p.y);
  expectBrush(await cursorAt(page, p), await classColour(page, 0));
  await page.keyboard.press("2");
  expectBrush(await cursorAt(page, p), await classColour(page, 1));
  await page.locator("#classes .class-colour").nth(1).fill("#12ab34");
  expectBrush(await cursorAt(page, p), "#12ab34");
  const panel = (await page.locator("#panel").boundingBox())!;
  expect((await cursorAt(page, { x: panel.x + 10, y: panel.y + panel.height - 10 })).startsWith("url(")).toBe(false);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Space");
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);
  await page.keyboard.up("Space");
  expectBrush(await cursorAt(page, p), "#12ab34");
  await page.click("#mode-pan");
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);
});
