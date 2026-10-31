import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { pixelAt as cellOf, strokeCells } from "../../src/core/pixel";
import {
  editName, paintMode, RGB_GRID, jumpTo, labels, message, moveTo, openApp, openRaster, rgbFixture, settled, toLngLat, toScreen, view, type LngLat, type Xy,
} from "./helpers";

// Spec 009: centre wheel zoom, middle-button pan, smooth WASD, and lifting the brush on a camera move.
const START: LngLat = [15, 45];
const idle = (page: Page) => page.evaluate(() => new Promise<void>((r) => {
  const { map } = (window as any).__geoapp;
  if (!map.isMoving()) r(); else map.once("idle", () => r());
}));
const centre = (page: Page) => page.evaluate(() => { const c = (window as any).__geoapp.map.getCenter(); return [c.lng, c.lat] as [number, number]; });
const mapCentreXy = async (page: Page): Promise<Xy> => {
  const b = (await page.locator("#map canvas").boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const canvasCursor = (page: Page) => page.evaluate(() => getComputedStyle((window as any).__geoapp.map.getCanvas()).cursor);
const storeKeys = (page: Page) => labels(page).then((m) => [...m].sort());

type Setup = "paint" | "pan" | "none";
async function setup(page: Page, how: Setup, zoom = 14, at: LngLat = START) {
  await openApp(page);
  if (how !== "none") {
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
  }
  if (how === "pan") await page.click("#mode-pan");
  await jumpTo(page, at, zoom);
}

/** CDP mouse with an explicit buttons mask (1 left, 2 right, 4 middle). */
function cdpMouse(cdp: CDPSession) {
  return (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Xy, button: "left" | "right" | "middle" | "none", buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button, buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
}

async function middleDrag(page: Page, a: Xy, b: Xy, steps = 15) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down({ button: "middle" });
  await moveTo(page, a, b, steps);
  await page.mouse.up({ button: "middle" });
}

test.describe("wheel zooms about the centre (criterion 1)", () => {
  for (const how of ["paint", "pan", "none"] as const) {
    test(`${how}: five wheel-ups off-centre raise the zoom and keep the centre`, async ({ page }) => {
      await setup(page, how);
      const c0 = await centre(page), z0 = (await view(page)).zoom;
      const m = await mapCentreXy(page);
      await page.mouse.move(m.x + 200, m.y + 100);
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
      await page.waitForTimeout(300);
      await idle(page);
      const c1 = await centre(page);
      expect((await view(page)).zoom).toBeGreaterThan(z0 + 0.3);
      expect(Math.abs(c1[0] - c0[0])).toBeLessThan(1e-7);
      expect(Math.abs(c1[1] - c0[1])).toBeLessThan(1e-7);
      if (how !== "none") { await settled(page); expect((await labels(page)).size).toBe(0); }
    });
  }
});

test.describe("middle-button drag pans (criterion 2)", () => {
  for (const how of ["paint", "pan", "none"] as const) {
    test(`${how}: the grabbed point follows the pointer; nothing else changes`, async ({ page }) => {
      await setup(page, how);
      const m = await mapCentreXy(page);
      const a = { x: m.x - 60, y: m.y - 40 }, b = { x: a.x + 150, y: a.y + 80 };
      const [grabbed] = await toLngLat(page, [a]);
      const v0 = await view(page);
      await middleDrag(page, a, b);
      await idle(page);
      const p = await toScreen(page, grabbed!);
      expect(Math.hypot(p.x - b.x, p.y - b.y)).toBeLessThanOrEqual(1);
      const v1 = await view(page);
      expect([v1.bearing, v1.pitch, v1.zoom]).toEqual([v0.bearing, v0.pitch, v0.zoom]);
      if (how !== "none") { await settled(page); expect((await labels(page)).size).toBe(0); }
    });
  }

  for (const how of ["paint", "pan", "none"] as const) {
    test(`${how}: at zoom 3 (globe) a rightward drag lowers the centre longitude`, async ({ page }) => {
      await setup(page, how, 3);
      const lon0 = (await centre(page))[0];
      const m = await mapCentreXy(page);
      await middleDrag(page, m, { x: m.x + 150, y: m.y });
      await idle(page);
      expect((await centre(page))[0]).toBeLessThan(lon0 - 1);
    });
  }
});

test.describe("middle-button details (criterion 3)", () => {
  test("mousedown with button 1 on the map is defaultPrevented; the cursor is grabbing during the drag only", async ({ page }) => {
    await setup(page, "paint");
    const m = await mapCentreXy(page);
    const prevented = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)!;
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 1, buttons: 4 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }, [m.x, m.y] as const);
    expect(prevented).toBe(true);
    const before = await canvasCursor(page);
    expect(before).not.toBe("grabbing");
    await page.mouse.move(m.x, m.y);
    await page.mouse.down({ button: "middle" });
    await moveTo(page, m, { x: m.x + 40, y: m.y + 10 }, 4);
    expect(await canvasCursor(page)).toBe("grabbing");
    await page.mouse.up({ button: "middle" });
    expect(await canvasCursor(page)).toBe(before);
  });

  test("a middle press during a left stroke neither pans nor ends it; a left press during a middle pan paints nothing", async ({ page }) => {
    await setup(page, "paint", 11);
    const send = cdpMouse(await page.context().newCDPSession(page));
    const m = await mapCentreXy(page);
    const v0 = await view(page);
    await send("mouseMoved", m, "none", 0);
    await send("mousePressed", m, "left", 1);
    await send("mouseMoved", { x: m.x + 20, y: m.y }, "left", 1);
    await send("mousePressed", { x: m.x + 20, y: m.y }, "middle", 5);
    for (let i = 1; i <= 6; i++) await send("mouseMoved", { x: m.x + 20 + 20 * i, y: m.y }, "left", 5);
    await send("mouseReleased", { x: m.x + 140, y: m.y }, "middle", 1);
    await send("mouseMoved", { x: m.x + 200, y: m.y }, "left", 1); // still the same stroke
    await send("mouseReleased", { x: m.x + 200, y: m.y }, "left", 0);
    await settled(page);
    const v1 = await view(page);
    expect([v1.lng, v1.lat]).toEqual([v0.lng, v0.lat]);
    const cols = [...(await labels(page)).keys()].map((k) => Number(k.split(",")[0]));
    const [l0] = await toLngLat(page, [m]), [l1] = await toLngLat(page, [{ x: m.x + 200, y: m.y }]);
    expect(Math.min(...cols)).toBeLessThanOrEqual(cellOf(RGB_GRID, ...l0!)[0]);
    expect(Math.max(...cols)).toBeGreaterThanOrEqual(cellOf(RGB_GRID, ...l1!)[0]); // painted to the end

    const n = (await labels(page)).size;
    const q = { x: m.x, y: m.y + 120 };
    await send("mouseMoved", q, "none", 0);
    await send("mousePressed", q, "middle", 4);
    await send("mouseMoved", { x: q.x + 10, y: q.y }, "middle", 4);
    await send("mousePressed", { x: q.x + 10, y: q.y }, "left", 5);
    for (let i = 1; i <= 5; i++) await send("mouseMoved", { x: q.x + 10 + 15 * i, y: q.y + 5 * i }, "middle", 5);
    await send("mouseReleased", { x: q.x + 85, y: q.y + 25 }, "left", 4);
    await send("mouseReleased", { x: q.x + 85, y: q.y + 25 }, "middle", 0);
    await settled(page);
    expect((await labels(page)).size).toBe(n);
  });

  const ends: [string, (page: Page, send: ReturnType<typeof cdpMouse>, p: Xy) => Promise<void>][] = [
    ["release over the panel", async (page, send) => {
      const b = (await page.locator("#panel").boundingBox())!;
      const over = { x: b.x + 20, y: b.y + b.height - 20 };
      await send("mouseMoved", over, "middle", 4);
      await send("mouseReleased", over, "middle", 0);
    }],
    ["pointercancel", async (page) => { await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse" }))); }],
    ["a buttons: 0 move", async (_page, send, p) => { await send("mouseMoved", p, "none", 0); }],
  ];
  for (const [name, end] of ends) {
    test(`${name} ends the middle pan; later moves don't pan`, async ({ page }) => {
      await setup(page, "paint");
      const send = cdpMouse(await page.context().newCDPSession(page));
      const m = await mapCentreXy(page);
      await send("mouseMoved", m, "none", 0);
      await send("mousePressed", m, "middle", 4);
      for (let i = 1; i <= 4; i++) await send("mouseMoved", { x: m.x + 10 * i, y: m.y }, "middle", 4);
      await end(page, send, { x: m.x + 40, y: m.y });
      await idle(page);
      const v = await view(page);
      for (let i = 1; i <= 5; i++) await send("mouseMoved", { x: m.x + 40 + 15 * i, y: m.y + 10 * i }, "middle", 4);
      await idle(page);
      expect(await view(page)).toEqual(v);
      expect(await canvasCursor(page)).not.toBe("grabbing");
    });
  }
});

/** Hold keys for ms while sampling the screen position of the start centre every 25 ms in the page. */
async function hold(page: Page, keys: string[], ms: number) {
  await page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    const c = map.getCenter();
    const w = window as any;
    w.__samples = [];
    w.__sampler = setInterval(() => { const p = map.project(c); w.__samples.push([p.x, p.y]); }, 25);
    const p = map.project(c);
    w.__start = [p.x, p.y];
  });
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
  return page.evaluate(() => {
    const w = window as any;
    clearInterval(w.__sampler);
    const { map } = w.__geoapp;
    return { start: w.__start as [number, number], samples: w.__samples as [number, number][], view: { zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } };
  });
}
const distinct = (s: [number, number][]) => new Set(s.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)).size;

test.describe("WASD pans smoothly while held (criterion 5)", () => {
  for (const how of ["paint", "plus", "none"] as const) {
    test(`${how === "plus" ? "focus on +" : how}: W moves the view north, W+D diagonally, and stops on keyup`, async ({ page }) => {
      await setup(page, how === "plus" ? "paint" : how);
      if (how === "plus") await page.focus("#brush-larger");
      const v0 = await view(page);
      const w = await hold(page, ["KeyW"], 500);
      const last = w.samples.at(-1)!;
      const dy = last[1] - w.start[1];
      expect(dy).toBeGreaterThanOrEqual(150);
      expect(dy).toBeLessThanOrEqual(450);
      expect(Math.abs(last[0] - w.start[0])).toBeLessThan(2);
      expect(distinct(w.samples)).toBeGreaterThanOrEqual(10);
      expect([w.view.zoom, w.view.bearing, w.view.pitch]).toEqual([v0.zoom, v0.bearing, v0.pitch]);
      const after = await centre(page);
      await page.waitForTimeout(300);
      expect(await centre(page)).toEqual(after);

      const wd = await hold(page, ["KeyW", "KeyD"], 500);
      const e = wd.samples.at(-1)!;
      const down = e[1] - wd.start[1], left = wd.start[0] - e[0];
      expect(down).toBeGreaterThan(100);
      expect(Math.abs(down - left) / down).toBeLessThan(0.1);
      if (how === "plus") await expect(page.locator("#brush-size")).toHaveText("7");
    });
  }
});

test.describe("WASD stops and ignores (criterion 6)", () => {
  async function stillWhileHeld(page: Page, start: () => Promise<void>) {
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(150);
    await start();
    await page.waitForTimeout(50);
    const c = await centre(page);
    await page.waitForTimeout(300);
    expect(await centre(page)).toEqual(c);
    await page.keyboard.up("KeyW");
  }

  test("a window blur during a hold stops it", async ({ page }) => {
    await setup(page, "paint");
    const c0 = await centre(page);
    await stillWhileHeld(page, () => page.evaluate(() => { window.dispatchEvent(new Event("blur")); }));
    expect(await centre(page)).not.toEqual(c0); // it did pan before the blur
  });

  test("pressing Shift during a hold stops it", async ({ page }) => {
    await setup(page, "paint");
    await stillWhileHeld(page, async () => { await page.keyboard.down("Shift"); });
    await page.keyboard.up("Shift");
  });

  test("W typed in a class name field types and doesn't pan", async ({ page }) => {
    await setup(page, "paint");
    const field = await editName(page, 0);
    await field.press("End");
    const c0 = await centre(page);
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(300);
    await page.keyboard.up("KeyW");
    expect(await centre(page)).toEqual(c0);
    await expect(field).toHaveValue("Class 1w");
  });

  for (const mod of ["Control", "Alt", "Meta"]) {
    test(`with ${mod} held, W doesn't pan`, async ({ page }) => {
      await setup(page, "paint");
      const c0 = await centre(page);
      await page.keyboard.down(mod);
      await page.keyboard.down("KeyW");
      await page.waitForTimeout(300);
      await page.keyboard.up("KeyW");
      await page.keyboard.up(mod);
      expect(await centre(page)).toEqual(c0);
    });
  }
});

test.describe("a camera move lifts the brush (criterion 7)", () => {
  const moves: [string, (page: Page) => Promise<void>][] = [
    ["wheel", async (page) => { await page.mouse.wheel(0, -100); await page.waitForTimeout(300); await idle(page); }],
    ["KeyD hold", async (page) => { await page.keyboard.down("KeyD"); await page.waitForTimeout(200); await page.keyboard.up("KeyD"); await idle(page); }],
  ];
  for (const [name, move] of moves) {
    test(`${name} mid-stroke: labels are strokeCells(p, q) plus r`, async ({ page }) => {
      await setup(page, "paint");
      while ((await page.locator("#brush-size").textContent()) !== "1") await page.click("#brush-smaller");
      const m = await mapCentreXy(page);
      const a = { x: m.x - 250, y: m.y - 150 }, b = { x: m.x + 250, y: m.y - 150 }, c = { x: m.x - 250, y: m.y + 250 };
      const [la, lb] = await toLngLat(page, [a, b]);
      const p = cellOf(RGB_GRID, ...la!), q = cellOf(RGB_GRID, ...lb!);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y);
      await move(page);
      await page.mouse.move(c.x, c.y);
      const [lc] = await toLngLat(page, [c]);
      const r = cellOf(RGB_GRID, ...lc!);
      await page.mouse.up();
      await settled(page);
      const want = new Set([...strokeCells(p, q), r].map(([x, y]) => `${x},${y}`));
      expect(want.size).toBeGreaterThan(2);
      expect((await storeKeys(page)).map(([k]) => k).sort()).toEqual([...want].sort());
    });
  }
});
