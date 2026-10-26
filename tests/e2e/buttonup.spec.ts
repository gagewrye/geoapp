import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { checkRing, normalizeLon } from "../../src/core/ring";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpTo, lonDiff, message, openApp, renderedPolygons, setMode, snapshot, toLngLat, toScreen, type LngLat } from "./helpers";

// Tester: try to break the button-up pointermove handler (src/map/draw.ts, F4 fix) and the
// isPrimary checks (src/map/dragGuard.ts, F3 fix); check criteria 2, 12, 14 and 15 still hold.

type Xy = { x: number; y: number };
type Ring = LngLat[];
const rings = async (page: Page): Promise<Ring[]> => (await snapshot(page)).map((f) => f.geometry.coordinates[0]);
const valid = (r: Ring) => checkRing(r.map(([x, y]) => [normalizeLon(x), y])) === null;
const lerp = (a: Xy, b: Xy, t: number): Xy => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dragPanEnabled = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.dragPan.isEnabled() as boolean);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Raw CDP mouse or pen; `held` false sends buttons 0 (a lost release when no mouseReleased came). */
function rawPointer(cdp: CDPSession, pointerType: "mouse" | "pen" = "mouse") {
  return (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Xy, held: boolean) =>
    cdp.send("Input.dispatchMouseEvent", {
      type, x: p.x, y: p.y, pointerType,
      button: type === "mouseMoved" && !held ? "none" : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

function toucher(cdp: CDPSession) {
  return (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", pts: [number, Xy][] = []) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([id, p]) => ({ id, x: p.x, y: p.y })) });
}

async function expectNothingInvalid(page: Page) {
  for (const r of await rings(page)) expect(valid(r), JSON.stringify(r)).toBe(true);
  for (const f of await renderedPolygons(page)) for (const r of f.coordinates) expect(valid(r), JSON.stringify(r)).toBe(true);
}

test.describe("draw mode is untouched by the button-up handler (criteria 2, 12, tester)", () => {
  for (const zoom of [3, 14]) {
    test(`zoom ${zoom}: long button-up hovers between clicks add no vertex and vertices equal unproject`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [15, 45], zoom);
      const mouse = rawPointer(await page.context().newCDPSession(page));
      const c = await toScreen(page, [15, 45]);
      const pts = [{ x: c.x - 120, y: c.y - 90 }, { x: c.x + 130, y: c.y - 80 }, { x: c.x + 110, y: c.y + 100 }, { x: c.x - 100, y: c.y + 90 }];
      const expected = await toLngLat(page, pts);
      const panel = (await page.locator("#panel").boundingBox())!;
      await page.fill("#class-name", "water");
      await setMode(page, "draw");
      let at = { x: panel.x + panel.width / 2, y: c.y };
      for (const p of [...pts, pts[0]!]) {
        // wander over the map and the panel with the button up, then click
        for (let i = 1; i <= 15; i++) await mouse("mouseMoved", lerp(at, { x: c.x, y: c.y + 150 }, i / 15), false);
        for (let i = 1; i <= 15; i++) await mouse("mouseMoved", lerp({ x: c.x, y: c.y + 150 }, p, i / 15), false);
        await mouse("mousePressed", p, true);
        await mouse("mouseReleased", p, false);
        await page.waitForTimeout(80);
        at = p;
      }
      const all = await rings(page);
      expect(all).toHaveLength(1);
      expect(all[0]).toHaveLength(5);
      for (const [elon, elat] of expected) {
        const hit = all[0]!.slice(0, 4).some(([lon, lat]) => Math.abs(lonDiff(lon, elon)) < 1e-6 && Math.abs(lat - elat) < 1e-6);
        expect(hit, `vertex at unproject ${elon},${elat} in ${JSON.stringify(all[0])}`).toBe(true);
      }
      expect((await snapshot(page))[0].properties.className).toBe("water");
      expect(errors).toEqual([]);
    });
  }

  test("a map pan in the middle of drawing, then more clicks, yields exactly the clicked vertices", async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [0, 0], 3);
    await setMode(page, "draw");
    const c = await toScreen(page, [0, 0]);
    await clickAt(page, { x: c.x - 100, y: c.y - 60 });
    await clickAt(page, { x: c.x + 100, y: c.y - 60 });
    // pan the map with the mouse (press on empty map, drag, release)
    await page.mouse.move(c.x, c.y + 150);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(c.x + 4 * i, c.y + 150 + 2 * i);
    await page.mouse.up();
    await page.waitForFunction(() => !(window as any).__geoapp.map.isMoving());
    const p3 = { x: c.x + 60, y: c.y + 80 }, p4 = { x: c.x - 80, y: c.y + 70 };
    const expected = await toLngLat(page, [p3, p4]);
    await clickAt(page, p3);
    await clickAt(page, p4);
    const first = (await page.evaluate(() => {
      const f = (window as any).__geoapp.draw.getSnapshot().find((g: any) => g.geometry.type === "Polygon");
      return f.geometry.coordinates[0][0];
    })) as LngLat;
    await clickAt(page, await toScreen(page, first));
    const all = await rings(page);
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveLength(5);
    for (const [elon, elat] of expected) {
      expect(all[0]!.some(([lon, lat]) => Math.abs(lonDiff(lon, elon)) < 1e-6 && Math.abs(lat - elat) < 1e-6)).toBe(true);
    }
  });
});

test.describe("select mode outside a feature drag is untouched by the button-up handler (tester)", () => {
  test("hovering after a normal drag keeps the edit and selection, and a click off the polygon deselects", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await jumpTo(page, [0, 0], 3);
    const c = await toScreen(page, [0, 0]);
    await drawPolygon(page, [{ x: c.x - 150, y: c.y - 100 }, { x: c.x + 150, y: c.y - 100 }, { x: c.x + 150, y: c.y + 100 }, { x: c.x - 150, y: c.y + 100 }], "a");
    await setMode(page, "select");
    await clickAt(page, c);
    const v = { x: c.x + 150, y: c.y - 100 };
    await page.mouse.move(v.x, v.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(v.x + 2 * i, v.y - 2 * i);
    await page.mouse.up();
    await page.waitForTimeout(80);
    const [edited] = await rings(page);
    for (let i = 1; i <= 30; i++) await page.mouse.move(v.x + 30 - 10 * i, v.y - 30 + 6 * i);
    await page.waitForTimeout(80);
    expect(await rings(page)).toEqual([edited]);
    const selected = () => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().some((f: any) => f.properties.selected));
    expect(await selected()).toBe(true);
    await clickAt(page, { x: c.x + 350, y: c.y + 250 });
    expect(await selected(), "a click on empty map deselects as before").toBe(false);
    expect(await rings(page)).toEqual([edited]);
    expect(errors).toEqual([]);
  });
});

test.describe("lost release across 180 (criterion 14, tester)", () => {
  for (const zoom of [3, 14]) {
    for (const what of ["body", "vertex"] as const) {
      test(`zoom ${zoom}: a ${what} drag across 180 whose mouseup is lost snaps back on the next button-up move; nothing invalid stored or rendered`, async ({ page }) => {
        const errors = collectErrors(page);
        await openApp(page);
        await jumpTo(page, [180, 0], zoom);
        const c = await toScreen(page, [180, 0]);
        const pts = [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }];
        await drawPolygon(page, pts, "a");
        await setMode(page, "select");
        await clickAt(page, { x: c.x - 115, y: c.y });
        const before = await rings(page);
        const mouse = rawPointer(await page.context().newCDPSession(page));
        const from = what === "body" ? { x: c.x - 115, y: c.y } : pts[1]!;
        const to = { x: from.x + 120, y: from.y };
        await mouse("mousePressed", from, true);
        for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(from, to, i / 20), true);
        await expect(message(page)).toHaveText(MESSAGES.antimeridian);
        // focus lost: no mouseup ever arrives, later moves report no button
        for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(to, { x: to.x + 60, y: to.y + 40 }, i / 10), false);
        await page.waitForTimeout(150);
        expect(await rings(page)).toEqual(before);
        await expectNothingInvalid(page);
        expect(await dragPanEnabled(page)).toBe(true);
        // it is over: hovering back across 180 edits nothing
        for (let i = 1; i <= 15; i++) await mouse("mouseMoved", lerp({ x: to.x + 60, y: to.y + 40 }, from, i / 15), false);
        for (let i = 1; i <= 15; i++) await mouse("mouseMoved", lerp(from, to, i / 15), false);
        await page.waitForTimeout(100);
        expect(await rings(page)).toEqual(before);
        expect(errors).toEqual([]);
      });
    }
  }
});

test.describe("lost release on the latitude guard (criterion 15, tester)", () => {
  const polar: Ring = [[-40, 60], [40, 60], [40, 82], [-40, 82]];
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [0, 75], 1.5);
    await drawPolygon(page, await Promise.all(polar.map((p) => toScreen(page, p))), "ice");
    await setMode(page, "select");
    await clickAt(page, await toScreen(page, [0, 72]));
  });

  test("a valid vertex drag whose mouseup is lost keeps exactly the last held position: the button-up move itself edits nothing", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
    const v = await toScreen(page, [40, 82]);
    const ok = await toScreen(page, [48, 78]);
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 20; i++) await mouse("mouseMoved", lerp(v, ok, i / 20), true);
    await page.waitForTimeout(50);
    const [held] = await rings(page);
    expect(held, "really dragged").not.toEqual(before);
    const far = await toScreen(page, [10, 66]);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(ok, far, i / 10), false);
    await page.waitForTimeout(100);
    expect(await rings(page)).toEqual([held]);
    expect(valid(held!)).toBe(true);
    expect(await dragPanEnabled(page)).toBe(true);
    await expect(message(page)).toHaveText("");
    expect(errors).toEqual([]);
  });

  test("a midpoint drag beyond MAX_LAT whose mouseup is lost snaps back, inserted vertex removed", async ({ page }) => {
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
    const mid = (await page.evaluate(() => (window as any).__geoapp.draw.getSnapshot()
      .filter((f: any) => f.properties.midPoint).map((f: any) => f.geometry.coordinates))) as LngLat[];
    const top = mid.reduce((a, b) => (b[1] > a[1] ? b : a)); // midpoint of the 82N edge
    const m = await toScreen(page, top);
    const beyond = await toScreen(page, [top[0], 88]);
    await mouse("mousePressed", m, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(m, beyond, i / 25), true);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(beyond, m, i / 10), false);
    await page.waitForTimeout(150);
    expect(await rings(page)).toEqual([before]);
  });

  test("known gap: mouseup lost right after the press, before any move: button-up moves past the limit store nothing invalid or clamped", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
    const v = await toScreen(page, [40, 82]);
    const beyond = await toScreen(page, [40, 88]);
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(v, beyond, i / 25), false);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", lerp(beyond, await toScreen(page, [0, 65]), i / 10), false);
    await page.waitForTimeout(150);
    const [after] = await rings(page);
    expect(valid(after!), JSON.stringify(after)).toBe(true);
    for (const [, lat] of after!) expect(Math.abs(lat)).not.toBe(MAX_LAT);
    expect(after, "observed: the button-up moves did not drag the vertex at all").toEqual(before);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a pen vertex drag beyond MAX_LAT, released normally, snaps back; pen hover afterwards edits nothing", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const pen = rawPointer(await page.context().newCDPSession(page), "pen");
    const v = await toScreen(page, [40, 82]);
    const beyond = await toScreen(page, [40, 88]);
    for (let i = 1; i <= 5; i++) await pen("mouseMoved", { x: v.x - 30 + 6 * i, y: v.y }, false); // hover in
    await pen("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await pen("mouseMoved", lerp(v, beyond, i / 25), true);
    await pen("mouseReleased", beyond, false);
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);
    for (let i = 1; i <= 15; i++) await pen("mouseMoved", lerp(beyond, v, i / 15), false);
    expect(await rings(page)).toEqual([before]);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a valid pen vertex drag is stored (pen moves while touching report a button, so the drag is not cut short)", async ({ page }) => {
    const [before] = await rings(page);
    const pen = rawPointer(await page.context().newCDPSession(page), "pen");
    const v = await toScreen(page, [40, 82]);
    const ok = await toScreen(page, [50, 78]);
    await pen("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await pen("mouseMoved", lerp(v, ok, i / 25), true);
    await pen("mouseReleased", ok, false);
    await page.waitForTimeout(150);
    const [after] = await rings(page);
    expect(after).not.toEqual(before);
    const moved = after!.find(([lon, lat]) => !before!.some(([a, b]) => a === lon && b === lat))!;
    const [target] = await toLngLat(page, [ok]);
    // the vertex followed the pen to the end of the drag, not stopped at the first move
    expect(Math.abs(moved[0] - target![0]) + Math.abs(moved[1] - target![1])).toBeLessThan(2);
    expect(valid(after!)).toBe(true);
  });

  test("follow-up probe: chorded buttons (left drag past the limit, right pressed, left released, right released) leave the polygon unchanged", async ({ page }) => {
    const [before] = await rings(page);
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, p: Xy, button: string, buttons: number) =>
      cdp.send("Input.dispatchMouseEvent", { type: type as any, x: p.x, y: p.y, button: button as any, buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
    const v = await toScreen(page, [40, 82]);
    const beyond = await toScreen(page, [40, 88]);
    await send("mousePressed", v, "left", 1);
    for (let i = 1; i <= 25; i++) await send("mouseMoved", lerp(v, beyond, i / 25), "left", 1);
    await send("mousePressed", beyond, "right", 3);
    await send("mouseReleased", beyond, "left", 2);
    const back = await toScreen(page, [40, 80]);
    for (let i = 1; i <= 10; i++) await send("mouseMoved", lerp(beyond, back, i / 10), "right", 2);
    await send("mouseReleased", back, "right", 0);
    await page.waitForTimeout(150);
    expect(await rings(page)).toEqual([before]);
    await expectNothingInvalid(page);
  });

  test("follow-up probe: a mouse hovering while a finger drags a vertex past the limit leaves the polygon unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = toucher(cdp);
    const mouse = rawPointer(cdp);
    const v = await toScreen(page, [40, 82]);
    const beyond = await toScreen(page, [40, 88]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]);
    const hover = await toScreen(page, [-20, 65]);
    for (let i = 1; i <= 5; i++) await mouse("mouseMoved", { x: hover.x + 5 * i, y: hover.y }, false);
    for (let i = 1; i <= 5; i++) await touch("touchMove", [[0, lerp(beyond, v, i / 5)]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    expect(await rings(page)).toEqual([before]);
    await expectNothingInvalid(page);
    expect(errors).toEqual([]);
  });
});

test.describe("multi-touch with the isPrimary checks (criteria 14-15, tester)", () => {
  test("a second finger tapping the polygon body while the first drags a vertex past MAX_LAT does not reset or start a drag", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await jumpTo(page, [0, 75], 1.5);
    const polar: Ring = [[-40, 60], [40, 60], [40, 82], [-40, 82]];
    await drawPolygon(page, await Promise.all(polar.map((p) => toScreen(page, p))), "ice");
    await setMode(page, "select");
    await clickAt(page, await toScreen(page, [0, 72]));
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, [40, 82]);
    const beyond = await toScreen(page, [40, 88]);
    const body = await toScreen(page, [0, 70]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]);
    await touch("touchStart", [[0, beyond], [1, body]]);
    for (let i = 1; i <= 5; i++) await touch("touchMove", [[0, beyond], [1, { x: body.x + 20 * i, y: body.y }]]);
    await touch("touchEnd", [[0, beyond]]); // finger 1 lifts first
    for (let i = 1; i <= 5; i++) await touch("touchMove", [[0, { x: beyond.x - 10 * i, y: beyond.y + 10 * i }]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);
    expect(await dragPanEnabled(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  for (const zoom of [3, 14]) {
    test(`zoom ${zoom}: a one-finger body drag across 180 (no second finger) is still blocked with the message`, async ({ page }) => {
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
      await touch("touchEnd");
      await page.waitForTimeout(150);
      await expect(message(page)).toHaveText(MESSAGES.antimeridian);
      expect(await rings(page)).toEqual(before);
      await expectNothingInvalid(page);
    });
  }
});
