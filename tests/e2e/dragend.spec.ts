import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpTo, message, moveTo, openApp, setMode, snapshot, toScreen } from "./helpers";

// A drag ends wherever, or however, the pointer is released (criteria 14-15).

const ring = async (page: Page) => (await snapshot(page)).map((f) => f.geometry.coordinates[0]);

test("a body drag across 180 released over the panel snaps back, and hovering back across 180 edits nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openApp(page);
  await jumpTo(page, [180, 0], 3);
  const c = await toScreen(page, [180, 0]);
  await drawPolygon(page, [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }], "a");
  await setMode(page, "select");
  const body = { x: c.x - 115, y: c.y };
  await clickAt(page, body);
  const before = await ring(page);
  const panel = (await page.locator("#panel").boundingBox())!;
  const outside = { x: panel.x + panel.width / 2, y: body.y };
  const east = { x: body.x + 110, y: body.y };
  await page.mouse.move(body.x, body.y);
  await page.mouse.down();
  await moveTo(page, body, east);
  await moveTo(page, east, outside);
  await page.mouse.up();
  await page.waitForTimeout(100);
  await expect(message(page)).toHaveText(MESSAGES.antimeridian);
  expect(await ring(page)).toEqual(before);
  await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
  // button up: back over the polygon and on across 180
  await moveTo(page, outside, body);
  await moveTo(page, body, east);
  await page.waitForTimeout(100);
  expect(await ring(page)).toEqual(before);
  await expect(message(page)).toHaveText("");
  expect(errors).toEqual([]);
});

test("a cancelled touch while drawing adds no vertex (a cancel is not a click)", async ({ page }) => {
  await openApp(page);
  await jumpTo(page, [0, 0], 3);
  await setMode(page, "draw");
  const cdp = await page.context().newCDPSession(page);
  const p = await toScreen(page, [0, 0]);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().length)).toBe(0);
});
