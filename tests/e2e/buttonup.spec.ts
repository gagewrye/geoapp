import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import {
  clickAt, collectErrors, dragPanEnabled, drawPolygon, expectNothingInvalid, jumpTo, lerp, lonDiff, message, openApp, polarSetup, rawPointer,
  rings, setMode, snapshot, toLngLat, toScreen, valid, type LngLat, type Xy,
} from "./helpers";

// Tester: the button-up pointermove handler (src/map/draw.ts, F4 fix) must not fire outside a
// feature drag, nor for pen or chorded-button drags; criteria 2, 12 and 15 still hold.

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

test.describe("pen and chorded buttons on the latitude guard (criterion 15, tester)", () => {
  test.beforeEach(async ({ page }) => polarSetup(page));

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
});
