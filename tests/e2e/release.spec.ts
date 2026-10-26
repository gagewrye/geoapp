import { expect, test } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import {
  collectErrors, dragPanEnabled, expectNothingInvalid, jumpTo, lerp, message, openApp, polarSetup, polarVertex, rawPointer, rings, toScreen, valid,
  westOf180, type LngLat,
} from "./helpers";

// Tester: a mouse drag released outside the browser window, or whose mouseup is lost (focus lost
// mid-drag: later moves report no button), must end; src/map/draw.ts pointer capture and button-up
// pointermove handling (criteria 14-15).

test.describe("mouse released outside the window or lost, on the latitude guard (criterion 15, tester)", () => {
  test.beforeEach(async ({ page }) => polarSetup(page));

  test("a blocked vertex drag released outside the browser window leaves the polygon unchanged, also after hovering back", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
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
    const mouse = rawPointer(await page.context().newCDPSession(page));
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

  test("a lost release (moves report no button, no mouseup ever arrives) ends the drag: the blocked edit is undone and hovering edits nothing", async ({ page }) => {
    // e.g. focus is lost mid-drag; Chrome then sends button-up mousemoves without a mouseup
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
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
});

test.describe("lost release across 180 (criterion 14, tester)", () => {
  for (const zoom of [3, 14]) {
    for (const what of ["body", "vertex"] as const) {
      test(`zoom ${zoom}: a ${what} drag across 180 whose mouseup is lost snaps back on the next button-up move; nothing invalid stored or rendered`, async ({ page }) => {
        const errors = collectErrors(page);
        await openApp(page);
        await jumpTo(page, [180, 0], zoom);
        const { pts, body } = await westOf180(page);
        const before = await rings(page);
        const mouse = rawPointer(await page.context().newCDPSession(page));
        const from = what === "body" ? body : pts[1]!;
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
