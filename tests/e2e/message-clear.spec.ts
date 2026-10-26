import { expect, test, type Page } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import {
  clickAt, collectErrors, drawPolygon, jumpTo, lerp, message, openApp, openRaster, polarSetup, polarVertex, rgbFixture, rings, setMode,
  snapshot, toScreen, valid, type LngLat,
} from "./helpers";

// Tester (round 3): src/ui/main.ts clears the message on an unblocked finish only when it is a
// block message, and a keydown resets the `blocked` flag. Try to clear a message that must stay,
// and to keep a block message that must go.

const rect = (page: Page, [w, s, e, n]: number[]) =>
  Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));

/** OPFS sink path with write number `holdAt` held until window.__release() is called. */
async function opfsHeldWrite(page: Page, holdAt: number) {
  await page.addInitScript((holdAt) => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const w = window as any;
    w.__writes = 0;
    w.__held = false;
    const proto = w.FileSystemWritableFileStream.prototype;
    const write = proto.write;
    proto.write = async function (this: unknown, d: unknown) {
      if (++w.__writes === holdAt) {
        w.__held = true;
        await new Promise<void>((r) => { w.__release = r; });
      }
      return write.call(this, d);
    };
  }, holdAt);
}

test.describe("non-block messages stay on an unblocked finish (tester)", () => {
  test("\"Classifying...\" stays while a polygon is finished during an export, then \"Export complete.\" shows", async ({ page }) => {
    const errors = collectErrors(page);
    await opfsHeldWrite(page, 3);
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "left");
    await drawPolygon(page, await rect(page, [17, 43, 19, 46]), "right");
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    const dl = page.waitForEvent("download");
    await page.click("#classify");
    await expect.poll(() => page.evaluate(() => (window as any).__held)).toBe(true);
    await expect(message(page)).toHaveText("Classifying...");

    await drawPolygon(page, await rect(page, [14, 47, 16, 49]), "third");
    expect(await snapshot(page)).toHaveLength(3);
    await expect(message(page)).toHaveText("Classifying...");
    // a select-mode drag of the new polygon also finishes unblocked
    await setMode(page, "select");
    const body = await toScreen(page, [15, 48]);
    await clickAt(page, body);
    await page.mouse.move(body.x, body.y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(body.x + 3 * i, body.y);
    await page.mouse.up();
    await page.waitForTimeout(100);
    await expect(message(page)).toHaveText("Classifying...");

    await page.evaluate(() => (window as any).__release());
    await dl;
    await expect(message(page)).toHaveText("Export complete.");
    expect(errors).toEqual([]);
  });

  test("a block, then a non-block message, then a valid finish: the non-block message stays", async ({ page }) => {
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
    await page.click("#train"); // no raster open
    await expect(message(page)).toHaveText("Open a raster first.");
    await clickAt(page, await toScreen(page, [0, 82]));
    await clickAt(page, first);
    expect(await snapshot(page)).toHaveLength(1);
    await expect(message(page)).toHaveText("Open a raster first.");
    expect(errors).toEqual([]);
  });

  test("typing a class name after a block keeps the block message until an unblocked finish", async ({ page }) => {
    const errors = collectErrors(page);
    await polarSetup(page);
    const [before] = await rings(page);
    const v = await toScreen(page, polarVertex);
    const beyond = await toScreen(page, [polarVertex[0], 88]);
    await page.mouse.move(v.x, v.y); await page.mouse.down();
    for (let i = 1; i <= 25; i++) { const p = lerp(v, beyond, i / 25); await page.mouse.move(p.x, p.y); }
    await page.mouse.up();
    await page.waitForTimeout(150);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual([before]);
    await page.fill("#class-name", "");
    await page.locator("#class-name").pressSequentially("water");
    await page.waitForTimeout(100);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(errors).toEqual([]);
  });
});

test.describe("Enter while the cursor is still past a limit (criteria 14, 15, tester)", () => {
  test("latitude: Enter with the hover vertex beyond MAX_LAT stores only the clicked vertices, nothing clamped", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await jumpTo(page, [0, 80], 1.5);
    await setMode(page, "draw");
    const clicked: LngLat[] = [[-10, 78], [10, 78], [0, 82]];
    for (const p of clicked) await clickAt(page, await toScreen(page, p));
    const beyond = await toScreen(page, [0, 88]);
    await page.mouse.move(beyond.x, beyond.y, { steps: 5 });
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    expect(s).toHaveLength(1);
    const ring = s[0].geometry.coordinates[0] as LngLat[];
    expect(ring).toHaveLength(4);
    for (const [, lat] of ring) { expect(Math.abs(lat)).toBeLessThan(MAX_LAT); expect(Math.abs(lat)).not.toBe(MAX_LAT); }
    expect(valid(ring)).toBe(true);
    console.log(`[probe] latitude Enter-while-beyond message: ${JSON.stringify(await message(page).textContent())}`);
    expect(errors).toEqual([]);
  });

  test("antimeridian: a hover across 180 blocks; Enter then stores the clicked polygon and clears the message", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await jumpTo(page, [180, 0], 3);
    await setMode(page, "draw");
    const clicked: LngLat[] = [[172, -3], [178, -3], [178, 3]];
    for (const p of clicked) await clickAt(page, await toScreen(page, p));
    const c = await toScreen(page, [180, 0]);
    const east = { x: c.x + 120, y: c.y };
    await page.mouse.move(east.x, east.y, { steps: 8 });
    await expect(message(page)).toHaveText(MESSAGES.antimeridian);
    const back = await toScreen(page, [174, 2]);
    await page.mouse.move(back.x, back.y, { steps: 8 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    expect(s).toHaveLength(1);
    expect(valid(s[0].geometry.coordinates[0])).toBe(true);
    await expect(message(page)).toHaveText("");
    expect(errors).toEqual([]);
  });

  test("antimeridian: Enter while the hover is still across 180 stores only valid vertices", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await jumpTo(page, [180, 0], 3);
    await setMode(page, "draw");
    for (const p of [[172, -3], [178, -3], [178, 3]] as LngLat[]) await clickAt(page, await toScreen(page, p));
    const c = await toScreen(page, [180, 0]);
    await page.mouse.move(c.x + 120, c.y, { steps: 8 });
    await expect(message(page)).toHaveText(MESSAGES.antimeridian);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    expect(s).toHaveLength(1);
    const ring = s[0].geometry.coordinates[0] as LngLat[];
    expect(ring).toHaveLength(4);
    expect(valid(ring)).toBe(true);
    for (const [lon] of ring) expect(lon).toBeGreaterThan(0);
    console.log(`[probe] antimeridian Enter-while-across message: ${JSON.stringify(await message(page).textContent())}`);
    expect(errors).toEqual([]);
  });
});

test("known gap (accepted): keys pressed during a blocked drag leave the polygon unchanged; the message survives keys before the last blocked move", async ({ page }) => {
  const errors = collectErrors(page);
  await polarSetup(page);
  const [before] = await rings(page);
  const v = await toScreen(page, polarVertex);
  const beyond = await toScreen(page, [polarVertex[0], 88]);
  await page.mouse.move(v.x, v.y); await page.mouse.down();
  for (let i = 1; i <= 15; i++) { const p = lerp(v, beyond, i / 25); await page.mouse.move(p.x, p.y); }
  await page.keyboard.down("Shift"); // mid-drag, already past the limit: later blocked moves set the flag again
  for (let i = 16; i <= 25; i++) { const p = lerp(v, beyond, i / 25); await page.mouse.move(p.x, p.y); }
  await page.keyboard.up("Shift");
  await page.waitForTimeout(50);
  await expect(message(page)).toHaveText(MESSAGES.latitude);
  await page.keyboard.press("Shift"); // after the last blocked move, before the release: the accepted gap
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await rings(page)).toEqual([before]);
  console.log(`[probe] key-after-last-blocked-move message: ${JSON.stringify(await message(page).textContent())}`);
  expect(errors).toEqual([]);
});
