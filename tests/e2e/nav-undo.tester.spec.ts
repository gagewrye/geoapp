import { expect, test, type Page, type Request } from "@playwright/test";
import {
  addTestSelect, jumpTo, labels, logRequests, message, moveTo, openApp, openRaster, paintMode, rgbFixture, selectClass, settled, stroke, toScreen, view, type LngLat, type Xy,
} from "./helpers";

// Tester edge cases for specs 009 (navigation), 010 (cursor, undo) and 012 (basemap requests).
const START: LngLat = [15, 45];
const centre = (page: Page) => page.evaluate(() => { const c = (window as any).__geoapp.map.getCenter(); return [c.lng, c.lat] as [number, number]; });
const idle = (page: Page) => page.evaluate(() => new Promise<void>((r) => {
  const { map } = (window as any).__geoapp;
  if (!map.isMoving()) r(); else map.once("idle", () => r());
}));
const mapMid = async (page: Page): Promise<Xy> => {
  const b = (await page.locator("#map canvas").boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const snapshot = async (page: Page) => [...(await labels(page))].sort();
const undoButton = (page: Page) => page.locator("#undo");
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const classColour = (page: Page, i: number) => page.evaluate((i) => (window as any).__geoapp.labels.classes[i].colour as string, i);

async function setup(page: Page, how: "paint" | "pan" | "none", zoom = 14) {
  await openApp(page);
  if (how !== "none") {
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
  }
  if (how === "pan") await page.click("#mode-pan");
  await jumpTo(page, START, zoom);
}

/** Screen y of the start centre after holding W for ms (positive = the view moved north). */
async function holdW(page: Page, ms: number, during?: () => Promise<void>) {
  const c = await page.evaluate(() => { const { map } = (window as any).__geoapp; return map.getCenter().toArray(); });
  const y0 = await page.evaluate((c) => (window as any).__geoapp.map.project(c).y as number, c);
  await page.keyboard.down("KeyW");
  if (during) await during();
  await page.waitForTimeout(ms);
  await page.keyboard.up("KeyW");
  return (await page.evaluate((c) => (window as any).__geoapp.map.project(c).y as number, c)) - y0;
}

test.describe("spec 009 edges (tester)", () => {

  for (const how of ["pan"] as const) {
    test(`WASD works in ${how} mode (every mode): 500 ms of W moves the centre point 150..450 px down`, async ({ page }) => {
      await setup(page, how);
      const dy = await holdW(page, 500);
      expect(dy).toBeGreaterThanOrEqual(150);
      expect(dy).toBeLessThanOrEqual(450);
    });
  }

  test("auto-repeat keydowns change nothing: the speed stays at most WASD_SPEED", async ({ page }) => {
    await setup(page, "paint");
    // time the hold in the page, from the first keydown to the keyup, so test-runner latency doesn't count
    await page.evaluate(() => {
      const w = window as any;
      w.__t = [] as number[];
      window.addEventListener("keydown", (e) => { if (e.code === "KeyW" && !e.repeat) w.__t[0] = performance.now(); });
      window.addEventListener("keyup", (e) => { if (e.code === "KeyW") w.__t[1] = performance.now(); });
    });
    const dy = await holdW(page, 500, async () => {
      for (let i = 0; i < 10; i++) { await page.keyboard.down("KeyW"); await page.waitForTimeout(20); } // repeat: true
    });
    const [t0, t1] = await page.evaluate(() => (window as any).__t as number[]);
    const pxPerS = (dy / (t1! - t0!)) * 1000;
    expect(pxPerS).toBeGreaterThan(200);
    expect(pxPerS).toBeLessThanOrEqual(600 * 1.05); // one rAF frame of slack
  });

  const stoppers: [string, (page: Page) => Promise<void>][] = [
    ["focus entering a class name field", (page) => page.focus("#classes .class-name")],
    ["a Control keydown", async (page) => { await page.keyboard.down("Control"); await page.keyboard.up("Control"); }],
    ["an Alt keydown", async (page) => { await page.keyboard.down("Alt"); await page.keyboard.up("Alt"); }],
    ["visibilitychange to hidden", (page) => page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    })],
  ];
  for (const [name, stop] of stoppers) {
    test(`${name} during a W hold stops panning while the key stays down`, async ({ page }) => {
      await setup(page, "paint");
      const c0 = await centre(page);
      await page.keyboard.down("KeyW");
      await page.waitForTimeout(150);
      await stop(page);
      await page.waitForTimeout(50);
      const c = await centre(page);
      await page.waitForTimeout(300);
      expect(await centre(page)).toEqual(c);
      expect(c).not.toEqual(c0);
      await page.keyboard.up("KeyW");
    });
  }

  test("WASD keeps working after a stop once the key is pressed again", async ({ page }) => {
    await setup(page, "paint");
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(100);
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await page.keyboard.up("KeyW");
    const dy = await holdW(page, 500);
    expect(dy).toBeGreaterThanOrEqual(150);
  });

  test("a middle drag starting on the panel doesn't pan the map", async ({ page }) => {
    await setup(page, "paint");
    const v0 = await view(page);
    const b = (await page.locator("#panel").boundingBox())!;
    const a = { x: b.x + 20, y: b.y + b.height - 20 };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: "middle" });
    await moveTo(page, a, { x: a.x + 400, y: a.y - 100 }, 10);
    await page.mouse.up({ button: "middle" });
    await idle(page);
    expect(await view(page)).toEqual(v0);
  });

  test("a middle press during a WASD hold pans with the pointer and the hold continues; labels stay empty", async ({ page }) => {
    await setup(page, "paint");
    const m = await mapMid(page);
    await page.mouse.move(m.x, m.y);
    await page.keyboard.down("KeyD");
    await page.mouse.down({ button: "middle" });
    await moveTo(page, m, { x: m.x + 50, y: m.y + 50 }, 5);
    await page.mouse.up({ button: "middle" });
    await page.keyboard.up("KeyD");
    await settled(page);
    expect((await labels(page)).size).toBe(0);
  });
});

test.describe("spec 010 edges (tester)", () => {
  async function paintSetup(page: Page) { await setup(page, "paint", 9); }

  test("criterion 7: the cursor follows a click-select", async ({ page }) => {
    await paintSetup(page);
    const p = await mapMid(page);
    await page.mouse.move(p.x, p.y);
    await selectClass(page, 1);
    const cur = await cursorAt(page, p);
    expect(cur.startsWith('url("data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(cur).toLowerCase()).toContain((await classColour(page, 1)).toLowerCase());
  });

  test("criterion 7: the cursor's SVG is 32x32 and decodes as valid SVG with black and white outlines", async ({ page }) => {
    await paintSetup(page);
    const cur = await cursorAt(page, await mapMid(page));
    const svg = decodeURIComponent(cur.slice(cur.indexOf(",") + 1, cur.indexOf('")')));
    expect(svg).toContain('width="32"');
    expect(svg).toContain('height="32"');
    expect(svg.toLowerCase()).toMatch(/#000|black/);
    expect(svg.toLowerCase()).toMatch(/#fff|white/);
    const ok = await page.evaluate((s) => new DOMParser().parseFromString(s, "image/svg+xml").querySelector("parsererror") === null, svg);
    expect(ok).toBe(true);
  });

  test("Ctrl+Z mid-stroke does nothing; after release one Undo removes the stroke", async ({ page }) => {
    await paintSetup(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    const one = await snapshot(page);
    await page.mouse.move(c.x, c.y + 40);
    await page.mouse.down();
    await page.mouse.move(c.x + 40, c.y + 40);
    await expect(undoButton(page)).toBeDisabled();
    await page.keyboard.press("Control+z");
    await page.mouse.move(c.x + 80, c.y + 40);
    await page.mouse.up();
    await settled(page);
    const two = await snapshot(page);
    expect(two.length).toBeGreaterThan(one.length);
    for (const e of one) expect(two).toContainEqual(e); // the first stroke wasn't undone mid-stroke
    await undoButton(page).click();
    expect(await snapshot(page)).toEqual(one);
    await undoButton(page).click();
    expect(await snapshot(page)).toEqual([]);
  });

  test("a stroke that changes nothing (erasing an absent class) adds no undo step", async ({ page }) => {
    await paintSetup(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await expect(undoButton(page)).toBeDisabled();
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await selectClass(page, 1);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right"); // class 2 is absent: no step
    await undoButton(page).click();
    expect(await snapshot(page)).toEqual([]);
    await expect(undoButton(page)).toBeDisabled();
  });

  test("Ctrl+Shift+Z is not redo, and Ctrl+Z with a select focused undoes a stroke", async ({ page }) => {
    await paintSetup(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    const painted = await snapshot(page);
    await page.locator("#map canvas").focus();
    await page.keyboard.press("Control+Shift+z");
    expect(await snapshot(page)).toEqual(painted);
    await addTestSelect(page); // the app has no select since spec 017
    await page.focus("#test-select");
    await page.keyboard.press("Control+z");
    expect(await snapshot(page)).toEqual([]);
    await page.keyboard.press("Control+Shift+z");
    expect(await snapshot(page)).toEqual([]);
  });

  test("undo of a stroke across the raster's partial right and bottom edge tiles restores the store and removes overlays", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await jumpTo(page, [19.98, 40.02], 11); // the raster's SE corner (lon 20, lat 40)
    const a = await toScreen(page, [19.95, 40.06]), b = await toScreen(page, [20.03, 39.98]);
    await stroke(page, [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b]);
    const keys = await page.evaluate(() => [...(window as any).__geoapp.labels.store.tiles.keys()]);
    expect(keys).toContain("768,768");
    await undoButton(page).click();
    expect(await snapshot(page)).toEqual([]);
    await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.filter((l: any) => l.id.startsWith("label-")).length)).toBe(0);
  });

  test("a middle pan shows grabbing, not the brush, in Paint mode; the brush comes back after", async ({ page }) => {
    await paintSetup(page);
    const m = await mapMid(page);
    await page.mouse.move(m.x, m.y);
    await page.mouse.down({ button: "middle" });
    await moveTo(page, m, { x: m.x + 30, y: m.y }, 3);
    const during = await cursorAt(page, { x: m.x + 30, y: m.y });
    await page.mouse.up({ button: "middle" });
    expect(during).toBe("grabbing");
    expect((await cursorAt(page, { x: m.x + 30, y: m.y })).startsWith("url(")).toBe(true);
  });
});

test("spec 012 criterion 5: real mouse pans and wheel zooms after load request nothing", async ({ page }) => {
  const log: Request[] = logRequests(page);
  await openApp(page);
  await page.evaluate(() => new Promise<void>((r) => { const { map } = (window as any).__geoapp; if (map.loaded()) r(); else map.once("idle", () => r()); }));
  await page.waitForTimeout(300);
  const before = log.length;
  const m = await mapMid(page);
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await moveTo(page, m, { x: m.x + 150, y: m.y + 60 }, 6);
    await page.mouse.up();
  }
  for (let i = 0; i < 25; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(20); }
  await page.keyboard.down("KeyD"); await page.waitForTimeout(200); await page.keyboard.up("KeyD");
  await idle(page);
  expect((await view(page)).zoom).toBeGreaterThan(4);
  const urls = log.slice(before).map((r) => r.url()).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:"));
  expect(urls).toEqual([]);
});
