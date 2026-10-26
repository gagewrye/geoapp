import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import {
  collectErrors, dragPanEnabled, expectNothingInvalid, lerp, message, moveTo, polarSetup, polarVertex, rawPointer, rings, toScreen, toucher, valid,
} from "./helpers";

// Tester: touch drags on the latitude guard ended by pointercancel, by lifting all fingers, or with
// a second finger down (src/map/draw.ts pointercancel handling, src/map/dragGuard.ts isPrimary checks).

test.describe("touch and pointercancel against the latitude guard (criterion 15, tester)", () => {
  test.beforeEach(async ({ page }) => polarSetup(page));

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

test.describe("multi-touch with the isPrimary checks (criterion 15, tester)", () => {
  test("a second finger tapping the polygon body while the first drags a vertex past MAX_LAT does not reset or start a drag", async ({ page }) => {
    const errors = collectErrors(page);
    await polarSetup(page);
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
});
