import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { collectErrors, dragPanEnabled, expectNothingInvalid, jumpTo, lerp, message, openApp, rings, toucher, valid, westOf180 } from "./helpers";

// Tester: touch drags across 180 ended by pointercancel, with a second finger, or with one finger
// (src/map/draw.ts pointercancel handling and src/map/dragGuard.ts isPrimary checks, criterion 14).

test.describe("pointercancel against the antimeridian guard (criterion 14, tester)", () => {
  for (const zoom of [3, 14]) {
    test(`zoom ${zoom}: a touch body drag across 180 ended by pointercancel snaps back with the antimeridian message`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      const { body } = await westOf180(page);
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
      const { c, body } = await westOf180(page);
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
      const { c, pts } = await westOf180(page);
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

test.describe("one-finger touch with the isPrimary checks (criterion 14, tester)", () => {
  for (const zoom of [3, 14]) {
    test(`zoom ${zoom}: a one-finger body drag across 180 (no second finger) is still blocked with the message`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      const { body } = await westOf180(page);
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
