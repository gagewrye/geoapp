import { expect, test } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import {
  clickAt, collectErrors, drawPolygon, jumpTo, lerp, message, openApp, openRaster, polarSetup, polarVertex, rawPointer, rgbFixture, rings,
  setMode, snapshot, toScreen, toucher, type LngLat,
} from "./helpers";

// Tester: the block message is cleared only by a later unblocked finish (src/ui/main.ts `blocked`
// flag, reset on a primary pointerdown or a keydown). Try other input paths than a plain mouse click or drag.

test("draw mode: a block from hovering alone (provisional update) shows the message, and a valid closing click clears it", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await jumpTo(page, [0, 80], 1.5);
  await setMode(page, "draw");
  const first = await toScreen(page, [-10, 78]);
  await clickAt(page, first);
  await clickAt(page, await toScreen(page, [10, 78]));
  const beyond = await toScreen(page, [0, 88]);
  await page.mouse.move(beyond.x, beyond.y, { steps: 5 });
  await expect(message(page)).toHaveText(MESSAGES.latitude);
  await clickAt(page, await toScreen(page, [0, 82]));
  await clickAt(page, first);
  const s = await snapshot(page);
  expect(s).toHaveLength(1);
  expect(s[0].geometry.coordinates[0]).toHaveLength(4); // three clicked vertices, closed; nothing from the hover
  for (const [, lat] of s[0].geometry.coordinates[0]) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
  await expect(message(page)).toHaveText("");
  expect(errors).toEqual([]);
});

test("draw mode: a block from hovering, then finishing with Enter, stores a valid polygon and clears the message", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await jumpTo(page, [0, 80], 1.5);
  await setMode(page, "draw");
  for (const p of [[-10, 78], [10, 78], [0, 82]] as LngLat[]) await clickAt(page, await toScreen(page, p));
  await clickAt(page, await toScreen(page, [0, 88]));
  await expect(message(page)).toHaveText(MESSAGES.latitude);
  const back = await toScreen(page, [-5, 80]);
  await page.mouse.move(back.x, back.y, { steps: 5 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(80);
  const s = await snapshot(page);
  expect(s).toHaveLength(1);
  for (const [, lat] of s[0].geometry.coordinates[0]) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
  await expect(message(page)).toHaveText("");
  expect(errors).toEqual([]);
});

test("an unblocked finish leaves a non-block message alone", async ({ page }) => {
  const errors = collectErrors(page);
  const rect = ([w, s, e, n]: number[]) => Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await drawPolygon(page, await rect([11, 43, 13, 46]), "left");
  await page.click("#train");
  await expect(message(page)).toHaveText("Draw polygons for at least two classes.");
  await drawPolygon(page, await rect([17, 43, 19, 46]), "right");
  expect(await snapshot(page)).toHaveLength(2);
  await expect(message(page)).toHaveText("Draw polygons for at least two classes.");
  expect(errors).toEqual([]);
});

test.describe("select mode on the latitude guard (criterion 15, tester)", () => {
  test.beforeEach(async ({ page }) => polarSetup(page));

  test("a blocked touch vertex drag, then a valid one-finger touch drag, clears the message", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const touch = toucher(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, beyond, i / 25)]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);

    const ok = await toScreen(page, [polarVertex[0], 84]);
    await touch("touchStart", [[0, v]]);
    for (let i = 1; i <= 25; i++) await touch("touchMove", [[0, lerp(v, ok, i / 25)]]);
    await touch("touchEnd");
    await page.waitForTimeout(150);
    expect(await rings(page)).not.toEqual([before]);
    await expect(message(page)).toHaveText("");
    expect(errors).toEqual([]);
  });

  test("a blocked drag, then a valid drag whose mouseup is lost, clears the message once the button-up move ends it", async ({ page }) => {
    const errors = collectErrors(page);
    const [before] = await rings(page);
    const mouse = rawPointer(await page.context().newCDPSession(page));
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(v, beyond, i / 25), true);
    await mouse("mouseReleased", beyond, false);
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);

    const ok = await toScreen(page, [polarVertex[0], 84]);
    await mouse("mousePressed", v, true);
    for (let i = 1; i <= 25; i++) await mouse("mouseMoved", lerp(v, ok, i / 25), true);
    await mouse("mouseMoved", { x: ok.x + 1, y: ok.y }, false); // lost mouseup: next move reports no button
    await page.waitForTimeout(150);
    const [after] = await rings(page);
    expect(after).not.toEqual(before);
    for (const [, lat] of after!) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
    await expect(message(page)).toHaveText("");
    expect(errors).toEqual([]);
  });
});
