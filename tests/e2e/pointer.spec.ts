import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { checkRing, normalizeLon } from "../../src/core/ring";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpTo, lonDiff, message, openApp, setMode, snapshot, toLngLat, toScreen, type LngLat } from "./helpers";

// Tester: try to break the pointer capture and pointercancel handling in src/map/draw.ts
// (criterion 15, F1/F2 fixes) and check it did not regress map gestures or criteria 2, 12, 14.

type Xy = { x: number; y: number };
type Ring = LngLat[];
const rings = async (page: Page): Promise<Ring[]> => (await snapshot(page)).map((f) => f.geometry.coordinates[0]);
const allFeatures = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().length as number);
const view = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const c = map.getCenter();
  return { lng: c.lng as number, lat: c.lat as number, zoom: map.getZoom() as number };
});
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });
const dragPanEnabled = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.dragPan.isEnabled() as boolean);
const valid = (r: Ring) => checkRing(r.map(([x, y]) => [normalizeLon(x), y])) === null;
const lerp = (a: Xy, b: Xy, t: number): Xy => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function moveTo(page: Page, a: Xy, b: Xy, steps = 20) {
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
}

/** Raw CDP touch: each point is [id, xy]; an empty list ends (or cancels) every touch. */
function toucher(cdp: CDPSession) {
  return (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", pts: [number, Xy][] = []) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([id, p]) => ({ id, x: p.x, y: p.y })) });
}

/** Raw CDP mouse, so coordinates may lie outside the viewport (outside the browser window). */
function rawMouse(cdp: CDPSession) {
  return (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Xy, held: boolean) =>
    cdp.send("Input.dispatchMouseEvent", {
      type, x: p.x, y: p.y, button: type === "mouseMoved" && !held ? "none" : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

const polar: Ring = [[-40, 60], [40, 60], [40, 82], [-40, 82]];
const polarBody: LngLat = [0, 72];
const polarVertex: LngLat = [40, 82];

async function polarSetup(page: Page) {
  await openApp(page);
  await jumpTo(page, [0, 75], 1.5);
  await drawPolygon(page, await Promise.all(polar.map((p) => toScreen(page, p))), "ice");
  await setMode(page, "select");
  await clickAt(page, await toScreen(page, polarBody));
}

test.describe("map gestures still work with pointer capture (tester)", () => {
  for (const mode of ["draw", "select"] as const) {
    test(`${mode} mode: a mouse pan moves the map, a pan released over the panel ends there, and nothing is drawn`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const c = await toScreen(page, [0, 0]);
      const v0 = await view(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await moveTo(page, c, { x: c.x + 150, y: c.y + 40 });
      const v1 = await view(page);
      expect(Math.abs(v1.lng - v0.lng), "map panned").toBeGreaterThan(1);
      const panel = (await page.locator("#panel").boundingBox())!;
      await moveTo(page, { x: c.x + 150, y: c.y + 40 }, { x: panel.x + panel.width / 2, y: c.y });
      await page.mouse.up();
      await idle(page); // pan inertia
      const v2 = await view(page);
      // button up: hovering back over the map must not pan
      await moveTo(page, { x: panel.x + panel.width / 2, y: c.y }, { x: c.x + 200, y: c.y + 100 });
      await page.waitForTimeout(300);
      const v3 = await view(page);
      expect(Math.abs(v3.lng - v2.lng) + Math.abs(v3.lat - v2.lat), "no pan with the button up").toBeLessThan(1e-6);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(await dragPanEnabled(page)).toBe(true);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: wheel zoom still zooms`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const c = await toScreen(page, [0, 0]);
      await page.mouse.move(c.x, c.y);
      const z0 = (await view(page)).zoom;
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
      await page.waitForTimeout(800);
      expect((await view(page)).zoom).toBeGreaterThan(z0 + 0.3);
      expect(await allFeatures(page)).toBe(0);
    });

    test(`${mode} mode: a one-finger touch pan moves the map and draws nothing`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const touch = toucher(await page.context().newCDPSession(page));
      const c = await toScreen(page, [0, 0]);
      const v0 = await view(page);
      await touch("touchStart", [[0, c]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, { x: c.x + 8 * i, y: c.y }]]);
      await touch("touchEnd");
      await page.waitForTimeout(500);
      expect(Math.abs((await view(page)).lng - v0.lng), "map panned").toBeGreaterThan(1);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: a two-finger pinch zooms the map and draws nothing`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const touch = toucher(await page.context().newCDPSession(page));
      const c = await toScreen(page, [0, 0]);
      const z0 = (await view(page)).zoom;
      await touch("touchStart", [[0, { x: c.x - 20, y: c.y }]]);
      await touch("touchStart", [[0, { x: c.x - 20, y: c.y }], [1, { x: c.x + 20, y: c.y }]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, { x: c.x - 20 - 7 * i, y: c.y }], [1, { x: c.x + 20 + 7 * i, y: c.y }]]);
      await touch("touchEnd");
      await page.waitForTimeout(500);
      expect((await view(page)).zoom, "pinch zoomed in").toBeGreaterThan(z0 + 0.5);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: a touch pan ended by pointercancel draws nothing, edits nothing, and the next mouse polygon is exact`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      // an existing, selected polygon (select mode) must survive the cancelled pan unchanged
      const c = await toScreen(page, [0, 0]);
      await drawPolygon(page, [{ x: c.x - 250, y: c.y - 200 }, { x: c.x - 150, y: c.y - 200 }, { x: c.x - 150, y: c.y - 100 }, { x: c.x - 250, y: c.y - 100 }], "a");
      await setMode(page, mode);
      if (mode === "select") await clickAt(page, { x: c.x - 200, y: c.y - 150 });
      const before = await rings(page);
      const touch = toucher(await page.context().newCDPSession(page));
      await touch("touchStart", [[0, c]]);
      for (let i = 1; i <= 15; i++) await touch("touchMove", [[0, { x: c.x + 6 * i, y: c.y + 2 * i }]]);
      await touch("touchCancel");
      await page.waitForTimeout(300);
      expect(await rings(page), "existing polygon unchanged").toEqual(before);
      expect((await snapshot(page)).length, "no new polygon").toBe(1);
      expect(await dragPanEnabled(page), "map panning re-enabled").toBe(true);
      // criteria 2 and 12 still hold: draw by clicking four points, vertices = unproject of the clicks
      await jumpTo(page, [10, 5], 3);
      const d = await toScreen(page, [10, 5]);
      const pts = [{ x: d.x + 20, y: d.y - 60 }, { x: d.x + 160, y: d.y - 60 }, { x: d.x + 160, y: d.y + 60 }, { x: d.x + 20, y: d.y + 60 }];
      const expected = await toLngLat(page, pts);
      await drawPolygon(page, pts, "b");
      const all = await rings(page);
      expect(all).toHaveLength(2);
      const drawn = all.find((r) => r[0]![0] > 5)!;
      expect(drawn).toHaveLength(5);
      for (const [elon, elat] of expected) {
        const hit = drawn.slice(0, 4).some(([lon, lat]) => Math.abs(lonDiff(lon, elon)) < 1e-6 && Math.abs(lat - elat) < 1e-6);
        expect(hit, `vertex at unproject ${elon},${elat} in ${JSON.stringify(drawn)}`).toBe(true);
      }
      expect(errors).toEqual([]);
    });
  }
});

test.describe("pointer capture and pointercancel against the latitude guard (criterion 15, tester)", () => {
  test.beforeEach(async ({ page }) => polarSetup(page));

  test("a blocked vertex drag released outside the browser window leaves the polygon unchanged, also after hovering back", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const mouse = rawMouse(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    const outside = { x: beyond.x, y: -40 }; // above the viewport
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(v, beyond, i / 25), true);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(beyond, outside, i / 10), true);
    await mouse("mouseReleased", outside, false);
    await page.waitForTimeout(150);
    expect(await rings(page), "right after release outside the window").toEqual([before]);
    // the latitude block came first; off-globe moves past the window edge may then also trip the 180 check
    expect([MESSAGES.latitude, MESSAGES.antimeridian]).toContain(await message(page).textContent());
    for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(outside, v, i / 20), false);
    for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(v, beyond, i / 20), false);
    await page.waitForTimeout(150);
    expect(await rings(page), "after hovering back with the button up").toEqual([before]);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a valid vertex drag released outside the browser window ends: hovering back afterwards edits nothing", async ({ page }) => {
    const errors = collectErrors(page);
    const mouse = rawMouse(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const ok = await toScreen(page, [polarVertex[0] + 10, 78]);
    const outside = { x: 1100, y: ok.y }; // right of the 1024 px viewport
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(v, ok, i / 20), true);
    await mouse("mouseMoved", outside, true);
    await mouse("mouseReleased", outside, false);
    await page.waitForTimeout(150);
    const [after] = await rings(page);
    expect(valid(after!), JSON.stringify(after)).toBe(true);
    for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(outside, await toScreen(page, [0, 65]), i / 20), false);
    await page.waitForTimeout(150);
    expect(await rings(page), "hover with the button up edits nothing").toEqual([after]);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a blocked touch vertex drag with a second finger down, then all fingers lifted, leaves the polygon unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    const other = await toScreen(page, [-20, 65]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]);
    await touch("touchStart", [[0, beyond], [1, other]]);
    await touch("touchMove", [[0, beyond], [1, { x: other.x + 10, y: other.y }]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a blocked touch vertex drag with a second finger down, then touchcancel, leaves the polygon unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    const other = await toScreen(page, [-20, 65]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]);
    const during = (await rings(page))[0];
    expect(during, "touch really dragged the vertex").not.toEqual(before);
    await touch("touchStart", [[0, beyond], [1, other]]);
    await touch("touchCancel");
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);
    expect(await dragPanEnabled(page)).toBe(true);
    // and the drag is really over: a later mouse hover with no button edits nothing
    await moveTo(page, await toScreen(page, [0, 65]), v);
    await moveTo(page, v, beyond);
    expect(await rings(page)).toEqual([before]);
    expect(errors).toEqual([]);
  });

  test("a second finger landing mid-drag, before the limit is crossed, does not change what a blocked drag snaps back to", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    const other = await toScreen(page, [-20, 65]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]); // ~lat 84, still valid
    await touch("touchStart", [[0, lerp(v, beyond, 8 / 25)], [1, other]]);
    for (let i = 9; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)], [1, other]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page), "snapped back to the pre-press polygon, not to where the second finger landed").toEqual([before]);
    expect(errors).toEqual([]);
  });

  test("a lost release (moves report no button, no mouseup ever arrives) ends the drag: the blocked edit is undone and hovering edits nothing", async ({ page }) => {
    // e.g. focus is lost mid-drag; Chrome then sends button-up mousemoves without a mouseup
    const [before] = await rings(page);
    const mouse = rawMouse(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    const ok = await toScreen(page, [polarVertex[0] + 5, 78]);
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(v, beyond, i / 25), true);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(beyond, ok, i / 10), false);
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page), "button-up moves after a blocked drag must not edit the polygon").toEqual([before]);
  });

  test("a valid touch vertex drag ended by pointercancel ends the drag (no further edits) and stores a valid polygon", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const ok = await toScreen(page, [polarVertex[0] + 10, 78]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, lerp(v, ok, i / 20)]]);
    await touch("touchCancel");
    await page.waitForTimeout(150);
    const [after] = await rings(page);
    expect(after).not.toEqual(before);
    expect(valid(after!)).toBe(true);
    expect(await dragPanEnabled(page)).toBe(true);
    await moveTo(page, ok, await toScreen(page, [0, 65]));
    expect(await rings(page)).toEqual([after]);
    await expect(message(page)).toHaveText("");
    expect(errors).toEqual([]);
  });

  test("a touch tap on the selected polygon cancelled before moving (pre-drag) neither edits nor deselects", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const selected = () => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().some((f: any) => f.properties.selected));
    expect(await selected()).toBe(true);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    await touch("touchStart", [[0, v]]);
    await touch("touchCancel");
    await page.waitForTimeout(150);
    expect(await rings(page)).toEqual([before]);
    expect(await selected()).toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe("pointercancel against the antimeridian guard (criterion 14, tester)", () => {
  for (const zoom of [3, 14]) {
    test(`zoom ${zoom}: a touch body drag across 180 ended by pointercancel snaps back with the antimeridian message`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      const c = await toScreen(page, [180, 0]);
      await drawPolygon(page, [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }], "a");
      await setMode(page, "select");
      const body = { x: c.x - 115, y: c.y };
      await clickAt(page, body);
      const before = await rings(page);
      const touch = toucher(await page.context().newCDPSession(page));
      const east = { x: body.x + 120, y: body.y };
      await touch("touchStart", [[0, body]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, lerp(body, east, i / 20)]]);
      await touch("touchCancel");
      await page.waitForTimeout(150);
      await expect(message(page)).toHaveText(MESSAGES.antimeridian);
      expect(await rings(page)).toEqual(before);
      for (const r of await rings(page)) expect(valid(r)).toBe(true);
      expect(await dragPanEnabled(page)).toBe(true);
      expect(errors).toEqual([]);
    });

    test(`zoom ${zoom}: a touch body drag across 180 with a second finger down is blocked, shows the message and snaps back`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      const c = await toScreen(page, [180, 0]);
      await drawPolygon(page, [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }], "a");
      await setMode(page, "select");
      const body = { x: c.x - 115, y: c.y };
      await clickAt(page, body);
      const before = await rings(page);
      const touch = toucher(await page.context().newCDPSession(page));
      const east = { x: body.x + 120, y: body.y };
      const other = { x: c.x - 300, y: c.y + 200 };
      await touch("touchStart", [[0, body]]);
      for (let i = 1; i <= 4; i++) await touch("touchMove", [[0, lerp(body, east, i / 20)]]);
      await touch("touchStart", [[0, lerp(body, east, 4 / 20)], [1, other]]);
      for (let i = 5; i <= 20; i++) await touch("touchMove", [[0, lerp(body, east, i / 20)], [1, other]]);
      await touch("touchEnd");
      await page.waitForTimeout(150);
      await expect(message(page)).toHaveText(MESSAGES.antimeridian);
      expect(await rings(page)).toEqual(before);
      expect(errors).toEqual([]);
    });

    test(`zoom ${zoom}: a touch vertex drag across 180 ended by pointercancel is blocked and stores nothing invalid`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      const c = await toScreen(page, [180, 0]);
      const pts = [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }];
      await drawPolygon(page, pts, "a");
      await setMode(page, "select");
      await clickAt(page, { x: c.x - 115, y: c.y });
      const before = await rings(page);
      const touch = toucher(await page.context().newCDPSession(page));
      const v = pts[1]!;
      const east = { x: c.x + 60, y: v.y };
      await touch("touchStart", [[0, v]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, lerp(v, east, i / 20)]]);
      await touch("touchCancel");
      await page.waitForTimeout(150);
      await expect(message(page)).toHaveText(MESSAGES.antimeridian);
      expect(await rings(page)).toEqual(before);
      expect(errors).toEqual([]);
    });
  }
});
